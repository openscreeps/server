import { readFileSync } from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import { dirname, extname, resolve } from 'node:path';
import { runInThisContext } from 'node:vm';

interface CommonJsModule {
  id: string;
  filename: string;
  exports: unknown;
  loaded: boolean;
  children: CommonJsModule[];
  paths: string[];
  require: NodeJS.Require;
}

type ModuleBody = (
  exports: unknown,
  require: NodeJS.Require,
  module: CommonJsModule,
  filename: string,
  directory: string,
) => void;

/**
 * Trusted operator modules have their own CommonJS cache and dependency bindings. In particular,
 * two embedded servers must never share an @screeps/common singleton or patch Node's global loader.
 * This is module loading, not a security sandbox: installed mods have the operator's privileges.
 */
export class OriginalModuleLoader {
  readonly #modules: Record<string, CommonJsModule | undefined> = Object.create(null) as Record<
    string,
    CommonJsModule | undefined
  >;

  constructor(readonly bindings: Readonly<Record<string, unknown>>) {}

  load(filename: string): unknown {
    return this.#load(resolve(filename));
  }

  #load(filename: string): unknown {
    const existing = this.#modules[filename];
    if (existing) return existing.exports;
    const nativeRequire = createRequire(filename);
    const extension = extname(filename);
    if (extension === '.node' || extension === '.mjs') return nativeRequire(filename) as unknown;
    if (extension === '.json') {
      const value: unknown = JSON.parse(readFileSync(filename, 'utf8'));
      this.#modules[filename] = {
        id: filename,
        filename,
        exports: value,
        loaded: true,
        children: [],
        paths: [],
        require: nativeRequire,
      };
      return value;
    }
    const module: CommonJsModule = {
      id: filename,
      filename,
      exports: {},
      loaded: false,
      children: [],
      paths: nativeRequire.resolve.paths(filename) ?? [],
      require: nativeRequire,
    };
    const requireModule = (request: string): unknown => {
      if (Object.hasOwn(this.bindings, request)) return this.bindings[request];
      if (isBuiltin(request)) return nativeRequire(request) as unknown;
      const dependency = nativeRequire.resolve(request);
      const result = this.#load(dependency);
      const child = this.#modules[dependency];
      if (child && !module.children.includes(child)) module.children.push(child);
      return result;
    };
    const require = Object.assign(requireModule, {
      resolve: nativeRequire.resolve,
      cache: this.#modules,
      main: nativeRequire.main,
    }) as NodeJS.Require;
    module.require = require;
    this.#modules[filename] = module;
    try {
      const source = readFileSync(filename, 'utf8')
        .replace(/^\uFEFF/, '')
        .replace(/^#![^\n]*/, '');
      const compiled: unknown = runInThisContext(
        `(function(exports, require, module, __filename, __dirname) {\n${source}\n})`,
        { filename, lineOffset: -1 },
      );
      if (typeof compiled !== 'function') throw new Error(`Invalid CommonJS module: ${filename}`);
      (compiled as ModuleBody).call(
        module.exports,
        module.exports,
        require,
        module,
        filename,
        dirname(filename),
      );
      module.loaded = true;
      return module.exports;
    } catch (error) {
      Reflect.deleteProperty(this.#modules, filename);
      throw error;
    }
  }
}
