// Copyright (c) 2015-2016 Vadim Macagon
// MIT License, see LICENSE file for full terms.
"use strict";
var fs = require('fs');
var path = require('path');
var ts = require('typescript');
var chokidar = require('chokidar');
var fs_promisified_1 = require('fs-promisified');
var TimedLogger = (function () {
    function TimedLogger(logger) {
        this.logger = logger;
    }
    TimedLogger.prototype.log = function (message) {
        this.logger.log(message, new Date());
    };
    TimedLogger.prototype.warn = function (message) {
        this.logger.warn(message, new Date());
    };
    TimedLogger.prototype.error = function (error) {
        this.logger.error(error, new Date());
    };
    return TimedLogger;
}());
var useCaseSensitiveFileNames = process.platform !== "win32"
    && process.platform !== "win64"
    && process.platform !== "darwin";
var getCanonicalFileName = ts.createGetCanonicalFileName(useCaseSensitiveFileNames);
function transformOutputFiles(files, transforms) {
    // apply all the registered transforms in sequence
    var transformChain = Promise.resolve(files);
    transforms.forEach(function (transform) {
        transformChain = transformChain.then(transform);
    });
    return transformChain;
}
function writeOutputFiles(files) {
    // TODO: handle ts.OutputFile.writeByteOrderMark
    return Promise.all(files.map(function (file) { return fs_promisified_1.writeFile(file.name, file.text, 'utf8'); }))
        .then(function () { return Promise.resolve(); });
}
/**
 * Used by the [[LanguageService]] to load TypeScript source files and compiler options.
 */
var LanguageServiceHost = (function () {
    function LanguageServiceHost(project, logger) {
        this.project = project;
        this.logger = logger;
        this.fileCache = new Map();
        this.filesToLoad = [];
    }
    LanguageServiceHost.prototype.getCompilationSettings = function () {
        return this.project.compilerOptions;
    };
    /*
    getProjectVersion(): string {
      // todo: The project version should change whenever anything in the project changes,
      //       be it the compiler options, or source files being added/removed/modified.
      //       Implementing this will allow TypeScript to skip rebuilding ASTs etc. before
      //       emitting files if nothing has changed since the last time.
      return '0';
    }
    */
    /** Get root set of files in the compilation context. */
    LanguageServiceHost.prototype.getScriptFileNames = function () {
        return this.project.rootFilePaths;
    };
    LanguageServiceHost.prototype.getScriptVersion = function (filePath) {
        var cacheKey = this.getFileCacheKey(filePath);
        return this.fileCache.get(cacheKey).version.toString();
    };
    LanguageServiceHost.prototype.getScriptSnapshot = function (filePath) {
        var cacheKey = this.getFileCacheKey(filePath);
        var cacheEntry = this.fileCache.get(cacheKey);
        if (cacheEntry) {
            return cacheEntry.snapshot;
        }
        else {
            try {
                fs.accessSync(filePath, fs.R_OK);
            }
            catch (e) {
                // The TypeScript compiler will frequently probe the file system as it attempts to resolve
                // module imports so it's not at all unusual to end up here.
                return undefined;
            }
            var sourceCode = fs.readFileSync(filePath, 'utf8');
            var snapshot = ts.ScriptSnapshot.fromString(sourceCode);
            this.fileCache.set(cacheKey, { version: 0, snapshot: snapshot });
        }
    };
    LanguageServiceHost.prototype.getCurrentDirectory = function () {
        return process.cwd();
    };
    LanguageServiceHost.prototype.getDefaultLibFileName = function (options) {
        return ts.getDefaultLibFilePath(options);
    };
    LanguageServiceHost.prototype.reloadFile = function (filePath) {
        var _this = this;
        return fs_promisified_1.readFile(filePath, 'utf8')
            .then(function (sourceCode) {
            var snapshot = ts.ScriptSnapshot.fromString(sourceCode);
            var cacheKey = _this.getFileCacheKey(filePath);
            var cacheEntry = _this.fileCache.get(cacheKey);
            if (cacheEntry) {
                cacheEntry.version++;
                cacheEntry.snapshot = snapshot;
            }
            else {
                _this.fileCache.set(cacheKey, { version: 0, snapshot: snapshot });
            }
        });
    };
    LanguageServiceHost.prototype.loadProjectRootFiles = function () {
        var _this = this;
        return Promise.all(this.project.rootFilePaths.map(function (filePath) { return _this.reloadFile(filePath); }))
            .then(function () { return Promise.resolve(); });
    };
    LanguageServiceHost.prototype.reloadProject = function () {
        var _this = this;
        return ProjectLoader.loadFromConfigFile(this.project.projectFilePath)
            .then(function (reloadedProject) {
            reloadedProject.postCompileTransforms = _this.project.postCompileTransforms;
            _this.project = reloadedProject;
        })
            .then(function () { return _this.loadProjectRootFiles(); });
    };
    Object.defineProperty(LanguageServiceHost.prototype, "hasPendingFiles", {
        /** @return `true` iff there are files that are being loaded or need to be loaded. */
        get: function () {
            return this.filesToLoad.length !== 0;
        },
        enumerable: true,
        configurable: true
    });
    LanguageServiceHost.prototype.loadPendingFiles = function () {
        return Promise.resolve();
    };
    LanguageServiceHost.prototype.getFileCacheKey = function (filePath) {
        var absFilePath = path.isAbsolute(filePath)
            ? path.normalize(filePath)
            : path.resolve(process.cwd(), filePath);
        // normalize slashes and case
        return getCanonicalFileName(absFilePath.replace(/\\/g, '/'));
    };
    return LanguageServiceHost;
}());
function getDiagnosticMessageText(diagnostic) {
    var message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
    var category = ts.DiagnosticCategory[diagnostic.category];
    if (diagnostic.file) {
        var _a = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start), line = _a.line, character = _a.character;
        return "  " + category + " TS" + diagnostic.code + ": " + diagnostic.file.fileName + " (" + (line + 1) + "," + (character + 1) + "): " + message;
    }
    else {
        return "  " + category + " TS" + diagnostic.code + ": " + message;
    }
}
/**
 * Compiles TypeScript source files within a single compilation context
 * (that corresponds to a single project) and writes the generated output to disk.
 */
var LanguageService = (function () {
    function LanguageService(host, tsService, project, logger) {
        this.host = host;
        this.tsService = tsService;
        this.project = project;
        this.logger = logger;
        // nothing to do
    }
    /**
     * Feed the given source file to the TypeScript compiler and apply any post-compile transforms
     * to the generated code before writing it out to disk.
     */
    LanguageService.prototype.emitFile = function (filePath, checkGlobalDiagnostics) {
        var _this = this;
        return Promise.resolve()
            .then(function () {
            _this.logDiagnosticsForFile(filePath, checkGlobalDiagnostics);
            var output = _this.tsService.getEmitOutput(filePath);
            if (output.emitSkipped) {
                _this.logger.log("Failed to emit " + filePath);
            }
            else if (output.outputFiles.length > 0) {
                _this.logger.log("Emitting " + filePath);
                return transformOutputFiles(output.outputFiles, _this.project.postCompileTransforms)
                    .then(writeOutputFiles);
            }
        });
    };
    LanguageService.prototype.emitProject = function () {
        var _this = this;
        return Promise.resolve()
            .then(function () {
            var diagnostics = _this.tsService.getCompilerOptionsDiagnostics();
            diagnostics.forEach(function (diagnostic) { return _this.logger.log(getDiagnosticMessageText(diagnostic)); });
            if ((diagnostics.length === 0) || !_this.project.compilerOptions.noEmitOnError) {
                return Promise.all(_this.project.rootFilePaths.map(function (filePath) { return _this.emitFile(filePath, false); }))
                    .then(function () { return Promise.resolve(); });
            }
        });
    };
    LanguageService.prototype.logDiagnosticsForFile = function (filePath, checkGlobalDiagnostics) {
        var _this = this;
        var diagnostics;
        if (checkGlobalDiagnostics) {
            diagnostics = this.tsService.getCompilerOptionsDiagnostics()
                .concat(this.tsService.getSyntacticDiagnostics(filePath))
                .concat(this.tsService.getSemanticDiagnostics(filePath));
        }
        else {
            diagnostics = this.tsService.getSyntacticDiagnostics(filePath)
                .concat(this.tsService.getSemanticDiagnostics(filePath));
        }
        diagnostics.forEach(function (diagnostic) { return _this.logger.log(getDiagnosticMessageText(diagnostic)); });
    };
    return LanguageService;
}());
/**
 * Watches for changes to TypeScript source files on disk.
 */
var ProjectWatcher = (function () {
    function ProjectWatcher(logger) {
        this.logger = logger;
        this.isWatcherReady = false;
        this.projects = [];
        // maps file paths being watched to the callbacks that should be invoked when changes are detected
        this.watchedFilesMap = new Map();
    }
    ProjectWatcher.prototype.createWatcher = function (filesToWatch) {
        var _this = this;
        this.watcher = chokidar.watch(filesToWatch, { ignorePermissionErrors: true })
            .on('ready', function () {
            _this.isWatcherReady = true;
        })
            .on('change', function (filePath, stats) {
            if (_this.isWatcherReady) {
                var callbacks = _this.watchedFilesMap.get(filePath);
                if (callbacks) {
                    callbacks.forEach(function (callback) {
                        callback(filePath)
                            .catch(function (e) { return _this.logger.error(e); });
                    });
                }
                else {
                    _this.logger.warn(filePath + " doesn't appear to belong to any currently watched project.");
                }
            }
        })
            .on('error', function (e) { return _this.logger.error(e); });
    };
    /** Start watching the source files in the given project for changes. */
    ProjectWatcher.prototype.addProject = function (project, onProjectFileChanged, onSourceFileChanged) {
        var _this = this;
        this.projects.push(project);
        this.watchedFilesMap.set(project.projectFilePath, [onProjectFileChanged]);
        project.rootFilePaths.forEach(function (filePath) {
            var callbacks = _this.watchedFilesMap.get(filePath);
            if (callbacks) {
                callbacks.push(onSourceFileChanged);
            }
            else {
                callbacks = [onSourceFileChanged];
            }
            _this.watchedFilesMap.set(filePath, callbacks);
        });
        // todo: how does one kill the watcher when it's no longer needed?
        if (this.watcher) {
            this.watcher.add(project.projectFilePath);
            project.rootFilePaths.forEach(function (filePath) { return _this.watcher.add(filePath); });
        }
        else {
            this.createWatcher(project.rootFilePaths.concat(project.projectFilePath));
        }
    };
    /** Stop watching the source files in the given project for changes. */
    ProjectWatcher.prototype.removeProject = function (project) {
        // todo: stop watching the project files, and remove onFileChanged callbacks
    };
    return ProjectWatcher;
}());
/**
 * Watches one or more TypeScript projects for changes and incrementally rebuilds any source files
 * that change. Also applies optional transformations to the generated code before it's written out
 * to disk.
 */
var IncrementalBuildServer = (function () {
    /**
     * @param logger Logger instance that should be used to log any messages, warnings, and errors.
     */
    function IncrementalBuildServer(logger) {
        // this is shared by all language services
        this.documentRegistry = ts.createDocumentRegistry(useCaseSensitiveFileNames);
        // one language service per project
        this.services = [];
        this.logger = new TimedLogger(logger);
        this.watcher = new ProjectWatcher(this.logger);
    }
    IncrementalBuildServer.prototype.watchProject = function (project) {
        var _this = this;
        return Promise.resolve()
            .then(function () {
            // todo: check if the project is already being watched, if so throw an error
            var host = new LanguageServiceHost(project, _this.logger);
            var tsService = ts.createLanguageService(host, _this.documentRegistry);
            var service = new LanguageService(host, tsService, project, _this.logger);
            _this.services.push(service);
            return host.loadProjectRootFiles()
                .then(function () { return service.emitProject(); })
                .then(function () {
                // start watching for changes to the project
                _this.watcher.addProject(project, function (projectFilePath) {
                    return host.reloadProject()
                        .then(function () { return service.emitProject(); });
                }, function (sourceFilePath) {
                    return host.reloadFile(sourceFilePath)
                        .then(function () { return service.emitFile(sourceFilePath, true); });
                });
            });
        });
    };
    IncrementalBuildServer.prototype.unwatchProject = function (project) {
        this.watcher.removeProject(project);
        for (var i = 0; i < this.services.length; ++i) {
            if (this.services[i].project === project) {
                this.services.splice(i, 1);
            }
        }
    };
    return IncrementalBuildServer;
}());
exports.IncrementalBuildServer = IncrementalBuildServer;
/**
 * Builds TypeScript projects and applies optional transformations to the generated code before
 * it's written out to disk.
 */
var BuildServer = (function () {
    /**
     * @param logger Logger instance that should be used to log any messages, warnings, and errors.
     */
    function BuildServer(logger) {
        this.logger = new TimedLogger(logger);
    }
    /**
     * @return A promise that will be resolved with either be resolved with `true` if the build
     *         succeeds, or `false` if the build fails.
     */
    BuildServer.prototype.build = function (project) {
        var _this = this;
        return Promise.resolve()
            .then(function () {
            var program = ts.createProgram(project.rootFilePaths, project.compilerOptions);
            var diagnostics = ts.getPreEmitDiagnostics(program);
            diagnostics.forEach(function (diagnostic) { return _this.logger.log(getDiagnosticMessageText(diagnostic)); });
            var buildSucceeded = (diagnostics.length === 0);
            var outputFiles = [];
            var output = program.emit(undefined /*==all*/, function (fileName, data, writeByteOrderMark) {
                outputFiles.push({
                    name: fileName,
                    writeByteOrderMark: writeByteOrderMark,
                    text: data
                });
            });
            if (!output.emitSkipped && (outputFiles.length > 0)) {
                return transformOutputFiles(outputFiles, project.postCompileTransforms)
                    .then(writeOutputFiles)
                    .then(function () { return buildSucceeded; });
            }
            else {
                return buildSucceeded;
            }
        });
    };
    return BuildServer;
}());
exports.BuildServer = BuildServer;
/**
 * Locates and loads TypeScript project configuration files.
 */
var ProjectLoader = (function () {
    function ProjectLoader() {
    }
    /**
     * @return A promise that will either be resolved with a project configuration,
     *         or rejected with an error.
     */
    ProjectLoader.loadFromConfigFile = function (filePath) {
        return fs_promisified_1.readFile(filePath, 'utf8')
            .then(function (content) {
            var _a = ts.parseConfigFileTextToJson(filePath, content), config = _a.config, error = _a.error;
            if (error) {
                throw new Error(getDiagnosticMessageText(error));
            }
            else if (config) {
                // TypeScript will call readDirectory() to find source files if the `files` property is
                // missing from the config, unfortunately TypeScript expects the function to be
                // synchronous. To keep things asynchronous we provide a dummy function that does nothing,
                // and after TypeScript parses the rest of the config we can search for source files
                // asynchronously (if needed).
                var host = { readDirectory: function () { return []; } };
                var result = ts.parseJsonConfigFileContent(config, host, path.dirname(filePath));
                // TODO: if result.fileNames is empty search for source files in the project dir
                var project = {
                    projectFilePath: path.normalize(filePath),
                    rootFilePaths: result.fileNames.map(function (fileName) { return path.normalize(fileName); }),
                    compilerOptions: result.options,
                    postCompileTransforms: []
                };
                return project;
            }
        });
    };
    /**
     * Attempt to locate `tsconfig.json` in the given directory or one of its parent directories,
     * and load the project configuration from that file.
     *
     * @param dirPath Path to the directory in which the search should start.
     * @return A promise that will either be resolved with the project configuration loaded from disk,
     *         or rejected if no `tsconfig.json` could be located or loading failed.
     */
    ProjectLoader.loadFromDir = function (dirPath) {
        return ProjectLoader.findConfigFile(dirPath)
            .then(function (configPath) { return ProjectLoader.loadFromConfigFile(configPath); });
    };
    /**
     * Attempt to locate `tsconfig.json` in the given directory or one of its parent directories.
     *
     * @param searchPath Path to the directory in which the search should start.
     * @return A promise that will either be resolved with a path to a `tsconfig.json`,
     *         or rejected if no such file could be located.
     */
    ProjectLoader.findConfigFile = function (searchPath) {
        return new Promise(function (resolve, reject) {
            var projectConfigFilename = "tsconfig.json";
            fs_promisified_1.access(projectConfigFilename, fs.R_OK)
                .then(function () { return resolve(projectConfigFilename); })
                .catch(function () {
                var parentPath = path.dirname(searchPath);
                if (parentPath === searchPath) {
                    reject();
                }
                ProjectLoader.findConfigFile(parentPath)
                    .then(function (filePath) { return resolve(path.join('..', filePath)); });
            });
        });
    };
    return ProjectLoader;
}());
exports.ProjectLoader = ProjectLoader;
//# sourceMappingURL=index.js.map