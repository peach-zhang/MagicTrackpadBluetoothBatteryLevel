#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if magic_trackpad_battery_lib::hid::run_helper_if_requested() {
        return;
    }
    magic_trackpad_battery_lib::run();
}
