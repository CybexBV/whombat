// @libp2p/utils maps its "react-native" build of get-thin-waist-addresses to the Node file, which imports
// node:os. The secure channel never calls it (address discovery is libp2p-host functionality); this empty
// module satisfies Metro's resolver. The app's metro.config must alias node:os the same way.
module.exports = { networkInterfaces: () => ({}) };
module.exports.default = module.exports;
