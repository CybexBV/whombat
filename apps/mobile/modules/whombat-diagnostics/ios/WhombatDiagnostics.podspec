Pod::Spec.new do |s|
  s.name           = 'WhombatDiagnostics'
  s.version        = '0.1.0'
  s.summary        = 'What iOS knows about how Whombat ended'
  s.description    = 'Keeps the crash and hang reports and the daily exit counts iOS hands the app (MetricKit), for the app to tell its Whombat.'
  s.license        = 'AGPL-3.0-only'
  s.author         = 'Whombat'
  s.homepage       = 'https://whombat.com'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/CybexBV/whombat.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'MetricKit'

  s.source_files = '*.swift'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
