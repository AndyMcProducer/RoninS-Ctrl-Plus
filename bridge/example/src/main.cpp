/*
 * RoninS-Ctrl-Plus - CAN bridge example
 *
 * This is NOT the WebSocket bridge. It is a small console program that shows
 * exactly which DJIR_SDK calls the real bridge needs to wrap, with the safety
 * behaviour the browser expects.
 *
 * Build:
 *   git clone https://github.com/ConstantRobotics/DJIR_SDK.git ../../../DJIR_SDK
 *   cmake -S bridge/example -B bridge/example/build
 *   cmake --build bridge/example/build --config Release
 *
 * The JSON/WebSocket contract is documented in bridge/README.md.
 */

#include <atomic>
#include <chrono>
#include <cmath>
#include <csignal>
#include <iomanip>
#include <iostream>
#include <thread>

#include "DJIR_SDK.h"

using namespace DJIR_SDK;

namespace {

std::atomic<bool> g_running{true};

void on_signal(int) {
    g_running.store(false);
}

// The browser speaks in 0.1 degree units, which is exactly what the SDK uses.
int16_t clamp_angle(long value) {
    if (value < -1800) return -1800;
    if (value > 1800) return 1800;
    return static_cast<int16_t>(value);
}

void print_position(const char* tag, int16_t yaw, int16_t roll, int16_t pitch) {
    std::cout << "[" << tag << "] yaw=" << std::fixed << std::setprecision(1)
              << (yaw / 10.0) << " roll=" << (roll / 10.0)
              << " pitch=" << (pitch / 10.0) << " deg" << std::endl;
}

}  // namespace

int main() {
    std::signal(SIGINT, on_signal);
    std::signal(SIGTERM, on_signal);

    DJIRonin gimbal;

    std::cout << "Connecting to the gimbal over CAN..." << std::endl;
    if (!gimbal.connect()) {
        std::cerr << "Could not connect. Check the USB-CAN adapter, the 1 Mbit/s "
                     "bus, and the 0x222/0x223 IDs." << std::endl;
        return 1;
    }

    // Absolute moves are easier to reason about from a UI. The SDK's default is
    // already absolute, but being explicit avoids surprises.
    gimbal.set_move_mode(MoveMode::ABSOLUTE_CONTROL);

    // --- 1. Recenter slowly ------------------------------------------------
    std::cout << "Recentering over 2 s..." << std::endl;
    if (!gimbal.move_to(0, 0, 0, 2000)) {
        std::cerr << "Recenter command failed." << std::endl;
    }

    // --- 2. Read the current position --------------------------------------
    // get_current_position() waits for a CAN reply. In the real bridge this
    // belongs on a polling thread with a timeout, not inline with the socket.
    for (int i = 0; i < 20 && g_running.load(); ++i) {
        int16_t yaw = 0, roll = 0, pitch = 0;
        if (gimbal.get_current_position(yaw, roll, pitch)) {
            print_position("poll", yaw, roll, pitch);
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }

    // --- 3. A short, slow move ---------------------------------------------
    std::cout << "Moving to yaw=10 deg, pitch=-5 deg over 1.5 s..." << std::endl;
    gimbal.move_to(clamp_angle(100), 0, clamp_angle(-50), 1500);
    std::this_thread::sleep_for(std::chrono::milliseconds(1700));

    // --- 4. Speed control ---------------------------------------------------
    // The protocol only honours a speed command for ~0.5 s, so the browser
    // re-sends it every 100 ms while the stick is held. Do the same here.
    std::cout << "Yaw +15 deg/s for 1 s (re-sent every 100 ms)..." << std::endl;
    gimbal.set_speed_mode(SpeedControl::ENABLED, FocalControl::DISABLED);
    for (int i = 0; i < 10 && g_running.load(); ++i) {
        // SDK signature uses uint16_t, so this example only shows a positive
        // speed. Negative speeds need a manually built 0x0E/0x01 frame.
        gimbal.set_speed(150, 0, 0);
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }

    // --- 5. Always stop -----------------------------------------------------
    std::cout << "Stopping and disconnecting..." << std::endl;
    gimbal.set_speed_mode(SpeedControl::DISABLED, FocalControl::DISABLED);
    gimbal.set_speed(0, 0, 0);
    gimbal.disconnect();

    std::cout << "Done." << std::endl;
    return 0;
}
