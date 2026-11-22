Pod::Spec.new do |s|
  s.name           = 'WhombatLive'
  s.version        = '0.1.0'
  s.summary        = 'Whombat live activities (ActivityKit)'
  s.description    = 'Runs in progress and approvals that need a person, as ActivityKit live activities.'
  s.license        = 'AGPL-3.0-only'
  s.author         = 'Whombat'
  s.homepage       = 'https://whombat.com'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/CybexBV/whombat.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'ActivityKit', 'WidgetKit'

  # The widget extension's sources (widget/) belong to their own target, added by app.plugin.cjs.
  s.source_files = '*.swift'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
