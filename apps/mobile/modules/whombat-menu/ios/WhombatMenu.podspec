Pod::Spec.new do |s|
  s.name           = 'WhombatMenu'
  s.version        = '0.1.0'
  s.summary        = 'Whombat message menus as iOS draws them'
  s.description    = 'Wraps a message in a UIContextMenuInteraction: a long press lifts it with the reactions and the actions in a system menu.'
  s.license        = 'AGPL-3.0-only'
  s.author         = 'Whombat'
  s.homepage       = 'https://whombat.com'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/CybexBV/whombat.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'UIKit'

  s.source_files = '*.swift'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
