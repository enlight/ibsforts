// Copyright (c) 2015-2016 Vadim Macagon
// MIT License, see LICENSE file for full terms.

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import * as chokidar from 'chokidar';
import { readFile, writeFile, access } from 'fs-promisified';

export interface ILogger {
  log(message: string, time: Date): void;
  warn(message: string, time: Date): void;
  error(error: Error, time: Date): void;
}

class TimedLogger {
  constructor(private logger: ILogger) {
  }

  log(message: string): void {
    this.logger.log(message, new Date());
  }

  warn(message: string): void {
    this.logger.warn(message, new Date());
  }

  error(error: Error): void {
    this.logger.error(error, new Date());
  }
}

interface IHostFileCacheEntry {
  version: number;
  snapshot: ts.IScriptSnapshot;
}

const useCaseSensitiveFileNames =  process.platform !== "win32"
                                && process.platform !== "win64"
                                && process.platform !== "darwin";
const getCanonicalFileName = ts.createGetCanonicalFileName(useCaseSensitiveFileNames);

function transformOutputFiles(
  files: ts.OutputFile[], transforms: PostCompileTransform[]
): Promise<ts.OutputFile[]> {
  // apply all the registered transforms in sequence
  let transformChain = Promise.resolve(files);
  transforms.forEach(transform => {
    transformChain = transformChain.then(transform);
  });
  return transformChain;
}

function writeOutputFiles(files: ts.OutputFile[]): Promise<void> {
  // TODO: handle ts.OutputFile.writeByteOrderMark
  return Promise.all(files.map(file => writeFile(file.name, file.text, 'utf8')))
  .then(() => Promise.resolve());
}

/**
 * Used by the [[LanguageService]] to load TypeScript source files and compiler options.
 */
class LanguageServiceHost implements ts.LanguageServiceHost {
  private fileCache = new Map</*filePath:*/string, IHostFileCacheEntry>();
  private filesToLoad: string[] = [];

  constructor(private project: IProject, private logger: TimedLogger) {
  }

  getCompilationSettings(): ts.CompilerOptions {
    return this.project.compilerOptions;
  }

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
  getScriptFileNames(): string[] {
    return this.project.rootFilePaths;
  }

  getScriptVersion(filePath: string): string {
    const cacheKey = this.getFileCacheKey(filePath);
    return this.fileCache.get(cacheKey).version.toString();
  }

  getScriptSnapshot(filePath: string): ts.IScriptSnapshot {
    const cacheKey = this.getFileCacheKey(filePath);
    const cacheEntry = this.fileCache.get(cacheKey);
    if (cacheEntry) {
      return cacheEntry.snapshot;
    } else {
      try {
        fs.accessSync(filePath, fs.R_OK);
      } catch (e) {
        // The TypeScript compiler will frequently probe the file system as it attempts to resolve
        // module imports so it's not at all unusual to end up here.
        return undefined;
      }
      const sourceCode = fs.readFileSync(filePath, 'utf8');
      const snapshot = ts.ScriptSnapshot.fromString(sourceCode);
      this.fileCache.set(cacheKey, { version: 0, snapshot });
    }
  }

  getCurrentDirectory(): string {
    return process.cwd();
  }

  getDefaultLibFileName(options: ts.CompilerOptions): string {
    return ts.getDefaultLibFilePath(options);
  }

  reloadFile(filePath: string): Promise<void> {
    return readFile(filePath, 'utf8')
    .then(sourceCode => {
      const snapshot = ts.ScriptSnapshot.fromString(sourceCode);
      const cacheKey = this.getFileCacheKey(filePath);
      const cacheEntry = this.fileCache.get(cacheKey);
      if (cacheEntry) {
        cacheEntry.version++;
        cacheEntry.snapshot = snapshot;
      } else {
        this.fileCache.set(cacheKey, { version: 0, snapshot });
      }
    });
  }

  loadProjectRootFiles(): Promise<void> {
    return Promise.all(this.project.rootFilePaths.map(filePath => this.reloadFile(filePath)))
    .then(() => Promise.resolve());
  }

  reloadProject(): Promise<void> {
    return ProjectLoader.loadFromConfigFile(this.project.projectFilePath)
    .then(reloadedProject => {
      reloadedProject.postCompileTransforms = this.project.postCompileTransforms;
      this.project = reloadedProject;
    })
    .then(() => this.loadProjectRootFiles());
  }

  /** @return `true` iff there are files that are being loaded or need to be loaded. */
  get hasPendingFiles(): boolean {
    return this.filesToLoad.length !== 0;
  }

  loadPendingFiles(): Promise<void> {
    return Promise.resolve();
  }

  getFileCacheKey(filePath: string): string {
    let absFilePath = path.isAbsolute(filePath)
      ? path.normalize(filePath)
      : path.resolve(process.cwd(), filePath);
    // normalize slashes and case
    return getCanonicalFileName(absFilePath.replace(/\\/g, '/'));
  }
}

function getDiagnosticMessageText(diagnostic: ts.Diagnostic): string {
  let message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
  let category = ts.DiagnosticCategory[diagnostic.category];
  if (diagnostic.file) {
    const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    return `  ${category} ${diagnostic.file.fileName} (${line + 1},${character + 1}): ${message}`;
  } else {
    return `  ${category}: ${message}`;
  }
}

/**
 * Compiles TypeScript source files within a single compilation context
 * (that corresponds to a single project) and writes the generated output to disk.
 */
class LanguageService {
  constructor(
    private host: LanguageServiceHost, private tsService: ts.LanguageService,
    public project: IProject, private logger: TimedLogger
  ) {
    // nothing to do
  }

  emitFile(filePath: string): Promise<void> {
    return Promise.resolve()
    .then(() => {
      let output = this.tsService.getEmitOutput(filePath);
      if (output.emitSkipped) {
        this.logger.log(`Failed to emit ${filePath}`);
        // FIXME: when emitting the entire project compiler options and global diagnostics should
        //        only be emitted once
        this.logDiagnosticsForFile(filePath);
      } else if (output.outputFiles.length > 0) {
        this.logger.log(`Emitting ${filePath}`);
        return transformOutputFiles(output.outputFiles, this.project.postCompileTransforms)
        .then(writeOutputFiles);
      }
    });
  }

  emitProject(): Promise<void> {
    return Promise.all(this.project.rootFilePaths.map(filePath => this.emitFile(filePath)))
    .then(() => Promise.resolve());
  }

  private logDiagnosticsForFile(filePath: string) {
    const allDiagnostics = this.tsService.getCompilerOptionsDiagnostics()
      .concat(this.tsService.getSyntacticDiagnostics(filePath))
      .concat(this.tsService.getSemanticDiagnostics(filePath));

    allDiagnostics.forEach(diagnostic => this.logger.log(getDiagnosticMessageText(diagnostic)));
  }
}

export type OnWatchedFileChanged = (filePath: string) => Promise<void>;
export type PostCompileTransform = (files: ts.OutputFile[]) => Promise<ts.OutputFile[]>;

/**
 *
 */
export interface IProject {
  /** Absolute path to the project file. */
  projectFilePath: string;
  /** Paths to source files (usually relative). */
  rootFilePaths: string[];
  /** TypeScript compiler options. */
  compilerOptions: ts.CompilerOptions;
  /**
   * Transforms to apply to the output generated by TypeScript before it's written to disk.
   *
   * Each transform function should accept an array of files and return an array of transformed
   * files. Transforms are applied in the order they appear in the array, the input to the first
   * transform is the output from the TypeScript compiler, the input for each subsequent transform
   * is the output of the previous transform. The length of the array returned by a transform
   * function need not match the length of the array passed in, a zero length array can also be
   * returned to indicate no files should be written to disk.
   */
  postCompileTransforms: PostCompileTransform[];
}

/**
 * Watches for changes to TypeScript source files on disk.
 */
class ProjectWatcher {
  private isWatcherReady = false;
  private watcher: fs.FSWatcher;
  private projects: IProject[] = [];
  // maps file paths being watched to the callbacks that should be invoked when changes are detected
  private watchedFilesMap = new Map</*filePath:*/string, Array<OnWatchedFileChanged>>();

  constructor(private logger: TimedLogger) {
  }

  private createWatcher(filesToWatch: string[]): void {
    this.watcher = chokidar.watch(filesToWatch, { ignorePermissionErrors: true })
    .on('ready', () => {
      this.isWatcherReady = true;
    })
    .on('change', (filePath, stats) => {
      if (this.isWatcherReady) {
        const callbacks = this.watchedFilesMap.get(filePath);
        if (callbacks) {
          callbacks.forEach(callback => {
            callback(filePath)
            .catch(e => this.logger.error(e));
          });
        } else {
          this.logger.warn(`${filePath} doesn't appear to belong to any currently watched project.`);
        }
      }
    })
    .on('error', e => this.logger.error(e));
  }

  /** Start watching the source files in the given project for changes. */
  addProject(
    project: IProject, onProjectFileChanged: OnWatchedFileChanged,
    onSourceFileChanged: OnWatchedFileChanged
  ): void {
    this.projects.push(project);

    this.watchedFilesMap.set(project.projectFilePath, [onProjectFileChanged]);
    project.rootFilePaths.forEach(filePath => {
      let callbacks = this.watchedFilesMap.get(filePath);
      if (callbacks) {
        callbacks.push(onSourceFileChanged);
      } else {
        callbacks = [onSourceFileChanged];
      }
      this.watchedFilesMap.set(filePath, callbacks);
    });

    // todo: how does one kill the watcher when it's no longer needed?
    if (this.watcher) {
      this.watcher.add(project.projectFilePath);
      project.rootFilePaths.forEach(filePath => this.watcher.add(filePath));
    } else {
      this.createWatcher(project.rootFilePaths.concat(project.projectFilePath));
    }
  }

  /** Stop watching the source files in the given project for changes. */
  removeProject(project: IProject): void {
    // todo: stop watching the project files, and remove onFileChanged callbacks
  }
}

/**
 * Watches one or more TypeScript projects for changes and incrementally rebuilds any source files
 * that change. Also applies optional transformations to the generated code before it's written out
 * to disk.
 */
export class IncrementalBuildServer {
  // this is shared by all language services
  private documentRegistry = ts.createDocumentRegistry(useCaseSensitiveFileNames);
  // one language service per project
  private services: LanguageService[] = [];
  // one watcher to watch all projects
  private watcher: ProjectWatcher;
  private logger: TimedLogger;

  /**
   * @param logger Logger instance that should be used to log any messages, warnings, and errors.
   */
  constructor(logger: ILogger) {
    this.logger = new TimedLogger(logger);
    this.watcher = new ProjectWatcher(this.logger);
  }

  watchProject(project: IProject): Promise<void> {
    return Promise.resolve()
    .then(() => {
      // todo: check if the project is already being watched, if so throw an error
      const host = new LanguageServiceHost(project, this.logger);
      const tsService = ts.createLanguageService(host, this.documentRegistry);
      const service = new LanguageService(host, tsService, project, this.logger);
      this.services.push(service);
      return host.loadProjectRootFiles()
      // compile the entire project before adding it to the watcher
      .then(() => service.emitProject())
      .then(() => {
        // start watching for changes to the project
        this.watcher.addProject(
          project,
          projectFilePath => {
            return host.reloadProject()
            .then(() => service.emitProject());
          },
          sourceFilePath => {
            return host.reloadFile(sourceFilePath)
            .then(() => service.emitFile(sourceFilePath));
          }
        );
      });
    });
  }

  unwatchProject(project: IProject): void {
    this.watcher.removeProject(project);
    for (let i = 0; i < this.services.length; ++i) {
      if (this.services[i].project === project) {
        this.services.splice(i, 1);
      }
    }
  }
}

/**
 * Builds TypeScript projects and applies optional transformations to the generated code before
 * it's written out to disk.
 */
export class BuildServer {
  private logger: TimedLogger;
  /**
   * @param logger Logger instance that should be used to log any messages, warnings, and errors.
   */
  constructor(logger: ILogger) {
    this.logger = new TimedLogger(logger);
  }

  /**
   * @return A promise that will be resolved with either be resolved with `true` if the build
   *         succeeds, or `false` if the build fails.
   */
  build(project: IProject): Promise<boolean> {
    return Promise.resolve()
    .then(() => {
      const program = ts.createProgram(project.rootFilePaths, project.compilerOptions);
      const diagnostics = ts.getPreEmitDiagnostics(program);
      diagnostics.forEach(diagnostic => this.logger.log(getDiagnosticMessageText(diagnostic)));

      const outputFiles: ts.OutputFile[] = [];
      const output = program.emit(undefined/*==all*/, (fileName, data, writeByteOrderMark) => {
        outputFiles.push({
          name: fileName,
          writeByteOrderMark: writeByteOrderMark,
          text: data
        });
      });

      if (!output.emitSkipped && (outputFiles.length > 0)) {
        return transformOutputFiles(outputFiles, project.postCompileTransforms)
        .then(files => {
          writeOutputFiles(files);
          return true;
        });
      }
      return output.emitSkipped;
    });
  }
}

/**
 * Locates and loads TypeScript project configuration files.
 */
export class ProjectLoader {
  /**
   * @return A promise that will either be resolved with a project configuration,
   *         or rejected with an error.
   */
  static loadFromConfigFile(filePath: string): Promise<IProject> {
    return readFile(filePath, 'utf8')
    .then(content => {
      const { config, error } = ts.parseConfigFileTextToJson(filePath, content);
      if (error) {
        throw new Error(getDiagnosticMessageText(error));
      } else if (config) {
        // TypeScript will call readDirectory() to find source files if the `files` property is
        // missing from the config, unfortunately TypeScript expects the function to be
        // synchronous. To keep things asynchronous we provide a dummy function that does nothing,
        // and after TypeScript parses the rest of the config we can search for source files
        // asynchronously (if needed).
        const host: ts.ParseConfigHost = { readDirectory: () => [] };
        const result = ts.parseJsonConfigFileContent(config, host, path.dirname(filePath));
        // TODO: if result.fileNames is empty search for source files in the project dir
        const project: IProject = {
          projectFilePath: path.normalize(filePath),
          rootFilePaths: result.fileNames.map(fileName => path.normalize(fileName)),
          compilerOptions: result.options,
          postCompileTransforms: []
        };
        return project;
      }
    });
  }

  /**
   * Attempt to locate `tsconfig.json` in the given directory or one of its parent directories,
   * and load the project configuration from that file.
   *
   * @param dirPath Path to the directory in which the search should start.
   * @return A promise that will either be resolved with the project configuration loaded from disk,
   *         or rejected if no `tsconfig.json` could be located or loading failed.
   */
  static loadFromDir(dirPath: string): Promise<IProject> {
    return ProjectLoader.findConfigFile(dirPath)
    .then(configPath => ProjectLoader.loadFromConfigFile(configPath));
  }

  /**
   * Attempt to locate `tsconfig.json` in the given directory or one of its parent directories.
   *
   * @param searchPath Path to the directory in which the search should start.
   * @return A promise that will either be resolved with a path to a `tsconfig.json`,
   *         or rejected if no such file could be located.
   */
  static findConfigFile(searchPath: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let projectConfigFilename = "tsconfig.json";
      access(projectConfigFilename, fs.R_OK)
      .then(() => resolve(projectConfigFilename))
      .catch(() => {
        const parentPath = path.dirname(searchPath);
        if (parentPath === searchPath) {
          reject();
        }
        ProjectLoader.findConfigFile(parentPath)
        .then(filePath => resolve(path.join('..', filePath)))
      });
    });
  }
}
