APP := Starboard
BUILD_DIR := build
APP_PATH := $(BUILD_DIR)/Build/Products/Debug/$(APP).app

.PHONY: gen build run test clean

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

clean:
	rm -rf $(BUILD_DIR) $(APP).xcodeproj
