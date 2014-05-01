var es = require('event-stream'),
    merge = require('deeply'),
    rjs = require('gulp-requirejs'),
    File = require('gulp-util').File,
    Q = require('q'),
    _ = require('underscore');

module.exports = function(options) {
    // First run r.js to produce its default (non-bundle-aware) output. In the process,
    // we capture the list of modules it wrote.
    var primaryPromise = getRjsOutput(options);

    // Next, take the above list of modules, and for each configured bundle, write out
    // the bundle's .js file, excluding any modules included in the primary output. In
    // the process, capture the list of modules included in each bundle file.
    var bundlePromises = _.map(options.bundles || {}, function(bundleModules, bundleName) {
            return primaryPromise.then(function(primaryOutput) {
                return getRjsOutput({
                    out: bundleName + ".js",
                    baseUrl: options.baseUrl,
                    paths: options.paths,
                    include: bundleModules,
                    exclude: primaryOutput.modules
                }, bundleName);
            });
        });

    // Next, produce the "final" primary output by waiting for all the above to complete, then
    // concatenating the bundle config (list of modules in each bundle) to the end of the
    // primary file.
    var finalPrimaryPromise = Q.all([primaryPromise].concat(bundlePromises)).then(function(allOutputs) {
            var primaryOutput = allOutputs[0],
                bundleOutputs = allOutputs.slice(1),
                bundleConfig = _.object(bundleOutputs.map(function(bundleOutput) {
                    return [bundleOutput.itemName, bundleOutput.modules]
                })),
                bundleConfigCode = '\nrequire.config('
                    + JSON.stringify({ bundles: bundleConfig }, true, 2)
                    + ');\n';
            return new File({
                path: primaryOutput.file.path,
                contents: new Buffer(primaryOutput.file.contents.toString() + bundleConfigCode)
            });
        });

    // Convert the N+1 promises (N bundle files, 1 final primary file) into a single stream for gulp to await
    var allFilePromises = pluckPromiseArray(bundlePromises, 'file').concat(finalPrimaryPromise);
    return es.merge.apply(es, allFilePromises.map(promiseToStream));
}

function promiseToStream(promise) {
    var stream = es.pause();
    promise.then(function(result) {
        stream.resume();
        stream.end(result);
    }, function(err) {
        throw err;
    });
    return stream;
}

function streamToPromise(stream) {
    // Of course, this relies on the stream producing only one output. That is the case
    // for all uses in this file (wrapping rjs output, which is always one file).
    var deferred = Q.defer();
    stream.pipe(es.through(function(item) {
        deferred.resolve(item);
    }));
    return deferred.promise;
}

function pluckPromiseArray(promiseArray, propertyName) {
    return promiseArray.map(function(promise) {
        return promise.then(function(result) {
            return result[propertyName];
        });
    });
}

function getRjsOutput(options, itemName) {
    // Capture the list of written modules by adding to an array on each onBuildWrite callback
    var modulesList = [],
        patchedOptions = merge({}, options, {
            onBuildWrite: function(moduleName, path, contents) {
                modulesList.push(moduleName);
                return contents;
            }
        }),
        rjsOutputPromise = streamToPromise(rjs(patchedOptions));

    return rjsOutputPromise.then(function(file) {
        return { itemName: itemName, file: file, modules: modulesList };
    });
}
