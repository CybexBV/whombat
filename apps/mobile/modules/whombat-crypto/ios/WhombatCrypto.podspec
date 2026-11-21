Pod::Spec.new do |s|
  s.name           = 'WhombatCrypto'
  s.version        = '0.1.0'
  s.summary        = 'Whombat ChaCha20-Poly1305 and SHA-256 through CryptoKit'
  s.description    = 'The session cipher and the download hash from the system, with the same bytes as the pure-JS code.'
  s.license        = 'AGPL-3.0-only'
  s.author         = 'Whombat'
  s.homepage       = 'https://whombat.com'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/CybexBV/whombat.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'CryptoKit'

  s.source_files = '*.swift'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
