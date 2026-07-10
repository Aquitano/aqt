import AudioToolbox
import CoreGraphics
import CoreMedia
import ScreenCaptureKit
import SwiftUI

/// Captures system output only while the compact audio meter is actually visible.
/// ScreenCaptureKit supplies mono PCM buffers; `AudioSampleProcessor` reduces each
/// buffer to three numbers off-main and this object publishes at most 30 fps.
@MainActor
final class AudioVisualizerManager: ObservableObject {
    enum CaptureState: Equatable {
        case idle
        case permissionRequired
        case starting
        case active
        case failed(String)
    }

    @Published private(set) var levels = AudioLevels.zero
    @Published private(set) var captureState: CaptureState = .idle

    private var desiredActive = false
    private var generation = 0
    private var transitionTask: Task<Void, Never>?
    private var stream: SCStream?
    private lazy var processor = AudioSampleProcessor(
        onLevels: { [weak self] levels in
            Task { @MainActor in
                guard let self, self.desiredActive else { return }
                self.levels = levels
            }
        },
        onStopped: { [weak self] error in
            Task { @MainActor in self?.captureStopped(error) }
        }
    )

    /// Called from the compact view. Repeated calls are cheap and idempotent.
    func setActive(_ active: Bool) {
        guard desiredActive != active else { return }
        desiredActive = active
        generation += 1
        transitionTask?.cancel()
        transitionTask = nil

        if active {
            startIfAuthorized(generation: generation)
        } else {
            stop()
        }
    }

    /// Permission is requested only from the user's explicit Settings toggle,
    /// never just because a track happened to begin playing.
    func requestPermission() {
        if CGPreflightScreenCaptureAccess() {
            if captureState == .permissionRequired { captureState = .idle }
            if desiredActive { startIfAuthorized(generation: generation) }
            return
        }

        let granted = CGRequestScreenCaptureAccess()
        captureState = granted ? .idle : .permissionRequired
        if granted, desiredActive { startIfAuthorized(generation: generation) }
    }

    func refreshPermissionState(required: Bool = false) {
        if CGPreflightScreenCaptureAccess() {
            if captureState == .permissionRequired { captureState = .idle }
        } else if required || desiredActive {
            captureState = .permissionRequired
        }
    }

    private func startIfAuthorized(generation requestedGeneration: Int) {
        guard stream == nil, transitionTask == nil else { return }
        guard CGPreflightScreenCaptureAccess() else {
            captureState = .permissionRequired
            return
        }

        captureState = .starting
        transitionTask = Task { [weak self] in
            guard let self else { return }
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(
                    false,
                    onScreenWindowsOnly: true
                )
                try Task.checkCancellation()
                guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() })
                        ?? content.displays.first else {
                    throw AudioVisualizerError.noDisplay
                }

                let configuration = SCStreamConfiguration()
                // No screen output is attached. Tiny video dimensions and a queue
                // depth of one minimize the stream's unused display-side footprint.
                configuration.width = 2
                configuration.height = 2
                configuration.queueDepth = 1
                configuration.showsCursor = false
                configuration.capturesAudio = true
                configuration.excludesCurrentProcessAudio = true
                configuration.sampleRate = 48_000
                configuration.channelCount = 1
                configuration.streamName = "Notch audio visualizer"

                let filter = SCContentFilter(
                    display: display,
                    excludingApplications: [],
                    exceptingWindows: []
                )
                let newStream = SCStream(filter: filter, configuration: configuration, delegate: processor)
                try newStream.addStreamOutput(processor, type: .audio, sampleHandlerQueue: processor.queue)
                try await newStream.startCapture()

                guard !Task.isCancelled,
                      desiredActive,
                      generation == requestedGeneration else {
                    try? await newStream.stopCapture()
                    return
                }
                stream = newStream
                captureState = .active
                transitionTask = nil
                Log.media.info("Live system-audio visualizer started")
            } catch is CancellationError {
                transitionTask = nil
            } catch {
                transitionTask = nil
                levels = .zero
                captureState = CGPreflightScreenCaptureAccess()
                    ? .failed(error.localizedDescription)
                    : .permissionRequired
                Log.media.error("Audio visualizer failed: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    private func stop() {
        levels = .zero
        processor.reset()
        guard let stream else {
            if captureState != .permissionRequired { captureState = .idle }
            return
        }
        self.stream = nil
        captureState = .idle
        Task {
            try? await stream.stopCapture()
            Log.media.info("Live system-audio visualizer stopped")
        }
    }

    private func captureStopped(_ error: Error) {
        guard stream != nil else { return } // expected stop requested by us
        stream = nil
        levels = .zero
        processor.reset()
        captureState = desiredActive ? .failed(error.localizedDescription) : .idle
        Log.media.error("Audio visualizer stream stopped: \(error.localizedDescription, privacy: .public)")
    }
}

private enum AudioVisualizerError: LocalizedError {
    case noDisplay

    var errorDescription: String? {
        "No active display is available for system-audio capture."
    }
}

/// ScreenCaptureKit calls this object exclusively on `queue`. Its mutable DSP
/// state never crosses queues; only the small Sendable `AudioLevels` value does.
private final class AudioSampleProcessor: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    let queue = DispatchQueue(label: "com.aquitano.notch.audio-visualizer", qos: .userInteractive)

    private let onLevels: @Sendable (AudioLevels) -> Void
    private let onStopped: @Sendable (Error) -> Void
    private var analyzer = AudioBandAnalyzer()
    private var conversionScratch: [Float] = []
    private var lastPublishNanoseconds: UInt64 = 0
    private let publishIntervalNanoseconds: UInt64 = 33_333_333

    init(
        onLevels: @escaping @Sendable (AudioLevels) -> Void,
        onStopped: @escaping @Sendable (Error) -> Void
    ) {
        self.onLevels = onLevels
        self.onStopped = onStopped
    }

    func reset() {
        queue.async { [weak self] in
            self?.analyzer.reset()
            self?.lastPublishNanoseconds = 0
        }
    }

    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of type: SCStreamOutputType
    ) {
        guard type == .audio, sampleBuffer.isValid, CMSampleBufferDataIsReady(sampleBuffer),
              let format = CMSampleBufferGetFormatDescription(sampleBuffer),
              let description = CMAudioFormatDescriptionGetStreamBasicDescription(format),
              description.pointee.mFormatID == kAudioFormatLinearPCM else { return }

        var bufferList = AudioBufferList(
            mNumberBuffers: 1,
            mBuffers: AudioBuffer(mNumberChannels: 1, mDataByteSize: 0, mData: nil)
        )
        var retainedBlockBuffer: CMBlockBuffer?
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: nil,
            bufferListOut: &bufferList,
            bufferListSize: MemoryLayout<AudioBufferList>.size,
            blockBufferAllocator: kCFAllocatorDefault,
            blockBufferMemoryAllocator: kCFAllocatorDefault,
            flags: UInt32(kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment),
            blockBufferOut: &retainedBlockBuffer
        )
        guard status == noErr, bufferList.mNumberBuffers == 1,
              let data = bufferList.mBuffers.mData else { return }

        let asbd = description.pointee
        let levels: AudioLevels
        if asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0,
           asbd.mBitsPerChannel == 32 {
            let count = Int(bufferList.mBuffers.mDataByteSize) / MemoryLayout<Float>.size
            let samples = UnsafeBufferPointer(
                start: data.assumingMemoryBound(to: Float.self),
                count: count
            )
            levels = analyzer.process(samples, sampleRate: asbd.mSampleRate)
        } else if asbd.mFormatFlags & kAudioFormatFlagIsSignedInteger != 0,
                  asbd.mBitsPerChannel == 16 {
            let count = Int(bufferList.mBuffers.mDataByteSize) / MemoryLayout<Int16>.size
            if conversionScratch.count != count {
                conversionScratch = Array(repeating: 0, count: count)
            }
            let source = data.assumingMemoryBound(to: Int16.self)
            for index in 0..<count {
                conversionScratch[index] = Float(source[index]) / Float(Int16.max)
            }
            levels = conversionScratch.withUnsafeBufferPointer {
                analyzer.process($0, sampleRate: asbd.mSampleRate)
            }
        } else {
            return
        }

        let now = DispatchTime.now().uptimeNanoseconds
        guard now &- lastPublishNanoseconds >= publishIntervalNanoseconds else { return }
        lastPublishNanoseconds = now
        onLevels(levels)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        onStopped(error)
    }
}
