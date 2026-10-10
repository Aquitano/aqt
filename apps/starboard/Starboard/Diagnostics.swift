import os

/// Intervals and events for Instruments' Points of Interest track.
let signposter = OSSignposter(subsystem: "com.aquitano.starboard", category: .pointsOfInterest)
let log = Logger(subsystem: "com.aquitano.starboard", category: "Starboard")
