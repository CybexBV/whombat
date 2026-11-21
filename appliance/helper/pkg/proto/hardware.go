package proto

// OpHardwareLog returns the kernel's firmware and driver error lines of this boot for the hardware report (read-only;
// Whombat HD-03, MG-114): at most kernlog.Max cleaned lines in Result.KernelLog, oldest first. It takes no argument and
// waits for no other operation (the helper runs it outside its operation lock: a staging that takes an hour doesn't
// hold up an owner's About page).
const OpHardwareLog Op = "hardware-log"

func init() { ops[OpHardwareLog] = argNone }
