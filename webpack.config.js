const { path } = require('fs-jetpack');
const { env: { NODE_ENV } } = require('process');
const { EnvironmentPlugin } = require('webpack');
const MinifyPlugin = require('babel-minify-webpack-plugin');
const minifyPreset = require('babel-preset-minify');

function negotiate(production, otherwise, shared) {
    if(shared) {
        [ production, otherwise ].forEach(target => Object.assign(target, shared));
    }

    return NODE_ENV === 'production' ? production : otherwise;
}

module.exports = {
    entry: path('libraries', 'transpiled', 'application.js'),
    devtool: negotiate(undefined, 'eval-source-map'),

    devServer: {
        contentBase: path('libraries')
    },

    plugins: negotiate([
        new MinifyPlugin({}, { minifyPreset }),
        new EnvironmentPlugin({ NODE_ENV })
    ], []),

    output: {
        filename: 'application.js',
        path: path('libraries', 'resources')
    },

    module: {
        rules: [
            {
                test: /\.js$/,
                use: [ 'source-map-loader' ],
                enforce: 'pre'
            }
        ]
    }
};
