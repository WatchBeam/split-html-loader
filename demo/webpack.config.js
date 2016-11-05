const path = require('path');

module.exports = {
  resolve: {
    modules: [path.join(__dirname, '..', 'node_modules')],
  },
  entry: './demo/main.js',
  output: {
    filename: 'bundle.js'
  },
  module: {
    preLoaders: [
      { test: /\.html$/, loader: 'split-html?target=platform&value=xbox' },
    ],
    loaders: [
      { test: /\.html$/, loader: 'html' },
    ]
  }
};
