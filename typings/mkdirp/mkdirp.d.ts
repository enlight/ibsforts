// Type definitions for mkdirp 0.5.1
// Project: http://github.com/substack/node-mkdirp
// Definitions by: Bart van der Schoor <https://github.com/Bartvds>, Vadim Macagon <https://github.com/enlight>
// Definitions: https://github.com/borisyankov/DefinitelyTyped

declare module 'mkdirp' {
  type Options = {
    fs?: any;
    mode?: number | string;
  } | number | string;

	function mkdirp(dir: string, cb: (err: any, made: string) => void): void;
	function mkdirp(dir: string, opts: Options, cb: (err: any, made: string) => void): void;

	namespace mkdirp {
		function sync(dir: string, opts?: Options): string;
	}

  export = mkdirp;
}
