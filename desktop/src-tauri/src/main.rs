// Windows 上不要弹出控制台窗口；调试构建保留控制台便于看输出。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    dogmerger_lib::run();
}
