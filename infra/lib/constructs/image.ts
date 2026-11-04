import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import { Construct } from 'constructs';
import { buildSync } from 'esbuild';
import { CLI, LARK_BINARY_BASE } from '../../../shared/versions.js';
import { REPO_ROOT, type Config, type Derived } from '../config.js';

const CONTAINER_DIR = join(REPO_ROOT, 'container');
let bundled = false;

/** esbuild the container server once per process (the 8-combo matrix bundles once). */
export function bundleContainer(): void {
  if (bundled) return;
  buildSync({
    entryPoints: [join(CONTAINER_DIR, 'src/server.ts')],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    outfile: join(CONTAINER_DIR, 'dist/server.mjs'),
    banner: { js: "import{createRequire}from'module';const require=createRequire(import.meta.url);" },
    sourcemap: 'linked',
    minify: false,
    logLevel: 'warning',
  });
  bundled = true;
}

export interface ImageProps {
  cfg: Config;
  d: Derived;
}

export class Image extends Construct {
  readonly asset: ecrAssets.DockerImageAsset;

  constructor(scope: Construct, id: string, props: ImageProps) {
    super(scope, id);
    const { cfg, d } = props;
    if (!existsSync(join(CONTAINER_DIR, 'Dockerfile'))) throw new Error('container/Dockerfile is missing');
    bundleContainer();
    const cli = CLI[d.cliFamily];
    this.asset = new ecrAssets.DockerImageAsset(this, 'Image', {
      directory: CONTAINER_DIR,
      platform: ecrAssets.Platform.LINUX_ARM64,
      exclude: ['src', 'node_modules', '**/*.test.*'],
      buildArgs: {
        BASE_IMAGE: d.baseImage,
        NPM_REGISTRY: d.npmRegistry,
        IM: cfg.im,
        CLI_PKG: cli.pkg,
        CLI_VERSION: cli.version,
        CLI_PLATFORM_PKG: 'platformPkg' in cli ? cli.platformPkg : '',
        LARK_BINARY_BASE,
      },
    });
  }
}
