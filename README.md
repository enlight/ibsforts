# ibsforts
Incremental Build Server for TypeScript with pluggable post-compile transforms.

## Overview
A single build server process can watch multiple TypeScript projects for changes and recompile
only the source files that change. The build server also allows users to provide their own
post-compile transform functions that are applied to the output from the TypeScript compiler
before it's written out to disk. For example, if your TypeScript project targets the NodeJS
runtime you could configure TypeScript to emit ES6 and then provide a transform function that
runs Babel to convert ES6 constructs that aren't yet supported by NodeJS to ES5.

## Prerequisites
- [Node.js](https://nodejs.org/) **4.x.x or later**
- [NPM](https://www.npmjs.com/) **3.x.x** (older versions may work)

## License
MIT
