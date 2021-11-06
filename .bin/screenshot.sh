adb shell screencap -p /sdcard/screen.png
fileName=screenshot_$(date "+%Y%m%d%H%M%S").png
adb pull /sdcard/screen.png Downloads/${fileName}
adb shell rm /sdcard/screen.png
sips -Z 600 Downloads/${fileName}
