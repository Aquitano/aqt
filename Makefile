APP := Starboard
BUILD_DIR := build
APP_PATH := $(BUILD_DIR)/Build/Products/Debug/$(APP).app

.PHONY: gen build run test benchmark profile-build format lint clean

gen:
	xcodegen generate

build: gen
	xcodebuild -project $(APP).xcodeproj -scheme $(APP) -configuration Debug \
		-derivedDataPath $(BUILD_DIR) build

run: build
	pkill -x $(APP) || true
	open $(APP_PATH)

test: gen
	xcodebuild -project $(APP).xcodeproj -scheme $(APP) -configuration Debug \
		-derivedDataPath $(BUILD_DIR) test

benchmark: gen
	xcodebuild -project $(APP).xcodeproj -scheme StarboardBenchmarks -configuration Release \
		-derivedDataPath $(BUILD_DIR) ENABLE_TESTABILITY=YES test

profile-build: gen
	xcodebuild -project $(APP).xcodeproj -scheme $(APP) -configuration Release \
		-derivedDataPath $(BUILD_DIR) build

format:
	swiftformat Starboard StarboardTests StarboardBenchmarks Scripts

lint:
	swiftformat --lint Starboard StarboardTests StarboardBenchmarks Scripts
	swiftlint lint --strict

clean:
	rm -rf $(BUILD_DIR) $(APP).xcodeproj
