/**
 * Cessair command line interface tool for site development.
 * This code have to ensure to work on Node.js v8.4.0+ without Babel.
 **/

// Node.js built-in API.
const crypto = require('crypto');
const { delimiter, resolve, sep: separator } = require('path');
const { exit, stderr, env: { PATH: pathes } } = require('process');

// Third-party modules.
const chokidar = require('chokidar');
const execa = require('execa');
const { existsAsync, inspectTreeAsync, readAsync, writeAsync } = require('fs-jetpack');
const ora = require('ora');
const { compile: pugCompile } = require('pug');
const React = require('react');
const ReactDOMServer = require('react-dom/server');
const { StaticRouter: Router } = require('react-router');
const { renderRoutes } = require('react-router-config');
const yargs = require('yargs');

const usageTemplate = 'Usage:\n  node $0';

const yarnpm = (async () => {
    const candidates = pathes.split(delimiter).map(directory => resolve(directory, 'yarn'));

    for(const candidate of candidates) {
        if(await existsAsync(candidate)) {
            return 'yarn';
        }
    }

    return 'npm';
})();

function execute(target, options = {}) {
    const [ command, ...args ] = target.split(' ');

    return execa(command, args, options);
}

function catcher({ code, message }, callback = () => {}) {
    callback();
    stderr.cursorTo(0);
    stderr.write(message);
    exit(code);
}

function generateBuilder(usageString, chain = yargs => yargs) {
    return yargs => chain(
        yargs
            .usage(`${usageTemplate} ${usageString}`)
            .help('help', 'print this message')
    ).argv;
}

function generateHandler(asyncFunction) {
    return (...args) => asyncFunction(...args).catch(catcher);
}

yargs // eslint-disable-line
    // Disable locale detection
    .detectLocale(false)

    // Set help message.
    .usage(`${usageTemplate} <command>`)
    .help('help', 'print this message')
    .alias('?', 'help')
    .wrap(null)

    // Define build command.
    .command({
        command: 'build',
        describe: 'build the site',
        builder: generateBuilder('build', yargs => (
            yargs.option('watch', {
                describe: 'keep watching sources and build incrementally',
                default: false
            })
        )),

        handler: generateHandler(async ({ watch: watching }) => {
            function pascalize(source) {
                return source.trim()
                    .replace(/[^a-z\s]/gi, '')
                    .replace(/\s+/g, ' ')
                    .replace(/\s([a-z])/gi, (match, character) => character.toUpperCase())
                    .replace(/^([a-z])/, character => character.toUpperCase());
            }

            function checksum(source, algorithm = 'md5', encoding = 'hex') {
                return crypto
                    .createHash(algorithm)
                    .update(source, 'utf8')
                    .digest(encoding);
            }

            function routing(components, routingMap) {
                for(const { name, type, prefix, children } of components) {
                    const basename = name.replace(/^(.*)\.jsx?$/, '$1');
                    const uniquePath = prefix ? prefix + separator + basename : basename;
                    const uniqueKey = pascalize(uniquePath);

                    if(type === 'dir') {
                        routing(children.map(child => ({ ...child, prefix: uniquePath })), routingMap);

                        continue;
                    }

                    if(!/\.jsx?$/.test(name)) {
                        continue;
                    }

                    routingMap.set(uniqueKey, uniquePath);
                }
            }

            let spinner = ora().start(`Begin to ${watching ? 'keep watching' : 'build'}`);
            const spinnerCatcher = error => catcher(error, () => spinner.stop());

            function succeed(message) {
                spinner.succeed(message);

                return ora().start('Keep watching');
            }

            async function generateRouting() {
                spinner.text = 'Generate routing configuration';

                const components = await inspectTreeAsync('sources/components');
                const routingMap = new Map();

                routing(components.children, routingMap);

                await writeAsync('sources/routing.js', `${[
                    [ ...routingMap ].map(([ uniqueKey, uniquePath ]) => (
                        `import ${uniqueKey} from './components/${uniquePath}';`
                    )).join('\n'),

                    `const routes = [\n    ${[ ...routingMap ].map(([ uniqueKey, uniquePath ]) => (
                        `{ path: '/${uniquePath}.html', exact: true, component: ${uniqueKey} }`
                    )).join(',\n    ')}\n];`,

                    'export default routes;'
                ].join('\n\n')}\n`);
            }

            async function transpileScripts() {
                spinner.text = 'Transpile ES2015 modules to CommonJS';

                await execute('node cessair yarnpm build:babel').catch(spinnerCatcher);
            }

            async function generatePages() {
                spinner.text = 'Generate pages';

                const { default: routes } = require('./libraries/transpiled/routing'); // eslint-disable-line
                const renderPage = pugCompile(await readAsync('sources/skeleton.pug'));
                const renderedRoutes = renderRoutes(routes);

                await Promise.all(routes.map(({ path: location }) => (
                    writeAsync(`libraries${location}`, `${renderPage({
                        context: ReactDOMServer.renderToString(
                            React.createElement(Router, { location, context: {} }, renderedRoutes)
                        )
                    }).trim()}\n`)
                ))).catch(spinnerCatcher);
            }

            async function transpileStylesheets() {
                spinner.text = 'Transpile SCSS to CSS';

                await execute('node cessair yarnpm build:scss').catch(spinnerCatcher);
            }

            async function bundle() {
                spinner.text = 'Make bundle of application';

                await execute('node cessair yarnpm build:webpack').catch(spinnerCatcher);
            }

            async function buildIncrementally(path) {
                switch(true) {
                case /\.pug$/.test(path): {
                    await generatePages();

                    spinner = succeed(`Succeed to generate page '${path}'`);

                    break;
                }

                case /\.scss$/.test(path): {
                    await transpileStylesheets();

                    spinner = succeed(`Succeed to transpile stylesheet '${path}'`);

                    break;
                }

                case /\.jsx?$/.test(path): {
                    if(/^sources\/components/.test(path)) {
                        await generateRouting();

                        spinner = succeed(`Succeed to generate route '${path}'`);
                    }

                    await transpileScripts();

                    spinner = succeed(`Succeed to transpile script '${path}'`);

                    await bundle();

                    spinner = succeed('Succeed to make bundle of application');

                    break;
                }

                default: {
                    break;
                }
                }
            }

            // Make libraries directory.
            if(!(await existsAsync('libraries'))) {
                spinner.text = 'Make libraries directory';

                await execute('git clone --branch master . libraries').catch(catcher);
            }

            if(watching) {
                spinner.text = 'Keep watching';

                const caches = new Map();
                const watcher = chokidar.watch('sources', { ignored: /(^|[/\\])\../ });
                const pathRegExp = /\.(?:pug|scss|jsx?)$/;

                watcher.on('ready', () => {
                    watcher.on('add', path => {
                        if(!pathRegExp.test(path)) {
                            return;
                        }

                        readAsync(path).then(async contents => {
                            if(caches.has(path)) {
                                return;
                            }

                            caches.set(path, checksum(contents));

                            await buildIncrementally(path.replace(/^sources\//, ''));
                        });
                    });

                    watcher.on('unlink', path => {
                        if(!pathRegExp.test(path)) {
                            return;
                        }

                        caches.delete(path);
                    });

                    watcher.on('change', path => {
                        if(!pathRegExp.test(path)) {
                            return;
                        }

                        readAsync(path).then(async contents => {
                            if(caches.get(path) === checksum(contents)) {
                                return;
                            }

                            await buildIncrementally(path.replace(/^sources\//, ''));
                        });
                    });
                });
            } else {
                for(const action of [
                    generateRouting, transpileScripts, generatePages, transpileStylesheets, bundle
                ]) {
                    await action();
                }

                spinner.succeed('Succeed to build!');
            }
        })
    })

    // Define yarnpm command.
    .command({
        command: 'yarnpm [commands...]',
        describe: 'execute provided commands to yarn or npm',
        builder: generateBuilder('yarnpm [commands...]'),

        handler: generateHandler(async ({ commands }) => {
            await execute(`${await yarnpm} ${commands.join(' ')}`, { stdio: 'inherit' }).catch(error => {
                exit(error.code);
            });
        })
    })

    // Demand one command at least.
    .demandCommand(1, '')

    // Enable strict mode.
    .strict()

    // Make argv.
    .argv;
