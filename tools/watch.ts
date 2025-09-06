import process from 'node:process';
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { get } from 'node:http';
import { watch } from 'node:fs';
import { join, relative } from 'node:path';
import { readdir } from 'node:fs/promises';

function buildDevelop(): void {
  console.info('Building libraries...');
  execSync('npx nx run-many --target=build --all --configuration=development --parallel --output-style=stream --no-cloud', {
    stdio: 'inherit',
    encoding: 'utf8',
    timeout: 120000
  });
  console.info('Build completed');
}

function unpublishLocal(): void {
  try {
    console.info('Cleaning up previous packages...');
    const output = execSync('npx nx run-many --target=unpublish-local --all --parallel --output-style=stream --no-cloud', {
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 30000
    });
    if (output) {
      console.info(output);
    }
    console.info('Cleanup completed');
  } catch (error: unknown) {
    // Log detailed error information
    const execError = error as { stdout?: string; stderr?: string; code?: number };
    if (execError.stdout) {
      console.info('Stdout:', execError.stdout);
    }
    if (execError.stderr) {
      console.info('Stderr:', execError.stderr);
    }
    if (execError.code !== undefined && execError.code !== 0) {
      console.info(`Unpublish command exited with code ${execError.code}`);
    }
    console.info('No previous packages to clean up (this is normal on first run)');
  }
}

function publishLocal(): void {
  try {
    console.info('Publishing packages to local registry...');
    execSync('npx nx run-many --target=publish-local --all --parallel --output-style=stream --no-cloud', { 
      stdio: 'inherit',
      encoding: 'utf8',
      timeout: 60000
    });
    console.info('All packages published successfully!');
  } catch (error: Error | unknown) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (errorMsg.includes('cannot publish over the previously published versions') || 
        errorMsg.includes('You cannot publish over')) {
      console.log('Packages already exist at this version, skipping publish');
    } else {
      console.error('Publish completed with warnings');
    }
  }
}

let verdaccioProcess: ChildProcess | undefined;
let isRebuilding = false;
let rebuildTimer: NodeJS.Timeout | undefined;

const ignoredPatterns = [
  '.git',
  '.angular',
  '.cache',
  '.nx',
  '.verdaccio',
  'dist',
  'node_modules',
  'tmp',
  '*.spec.ts',
  '*.spec.js',
  '*.test.ts',
  '*.test.js'
];

function shouldIgnore(path: string): boolean {
  return ignoredPatterns.some(pattern => {
    if (pattern.includes('*')) {
      const regex = new RegExp(pattern.replace('*', '.*'));
      return regex.test(path);
    }
    return path.includes(pattern);
  });
}

function formatTime(): string {
  return new Date().toLocaleTimeString('en-US', { 
    hour12: false, 
    hour: '2-digit', 
    minute: '2-digit', 
    second: '2-digit' 
  });
}

function logChange(filepath: string): void {
  const relativePath = relative(process.cwd(), filepath);
  console.info(`[${formatTime()}] File changed: ${relativePath}`);
}

function killChildProcesses(): void {
  verdaccioProcess?.kill();
}

function debounce(func: () => void, delay: number): void {
  if (rebuildTimer) {
    clearTimeout(rebuildTimer);
  }
  rebuildTimer = setTimeout(func, delay);
}

async function setupFileWatchers(directories: string[]): Promise<void> {
  const watchers: Set<string> = new Set();

  async function watchDirectory(dir: string): Promise<void> {
    if (watchers.has(dir) || shouldIgnore(dir)) {
      return;
    }

    watchers.add(dir);
    
    watch(dir, { recursive: false }, (eventType, filename) => {
      if (!filename || shouldIgnore(filename)) {
        return;
      }

      const fullPath = join(dir, filename);
      logChange(fullPath);
      
      debounce(() => {
        if (!isRebuilding) {
          rebuildAll();
        }
      }, 1000);
    });

    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !shouldIgnore(entry.name)) {
          await watchDirectory(join(dir, entry.name));
        }
      }
    } catch (error) {
      console.error(`Failed to watch directory ${dir}:`, error);
    }
  }

  for (const dir of directories) {
    await watchDirectory(dir);
  }

  console.log(`Watching ${watchers.size} directories for changes`);
}

async function startVerdaccio(): Promise<void> {
  console.log('Starting Verdaccio local registry...');
  verdaccioProcess = spawn('npx', ['verdaccio', '-c', 'verdaccio.yaml'], { 
    stdio: 'inherit',
    shell: true 
  });
  
  verdaccioProcess.on('error', (error) => {
    console.error('Verdaccio process error:', error);
    if (!error.message.includes('EADDRINUSE')) {
      throw error;
    }
  });

  let attempts = 0;
  const maxAttempts = 30;
  
  while (attempts < maxAttempts) {
    attempts++;
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    try {
      const isReady = await new Promise<boolean>((resolve) => {
        get('http://localhost:4873/-/ping', (res) => {
          resolve(res.statusCode === 200);
        }).on('error', () => {
          resolve(false);
        });
      });
      
      if (isReady) {
        console.log('Verdaccio is ready!');
        return;
      }
    } catch (error: Error | unknown) {
      if (error instanceof Error && !error.message.includes('ECONNREFUSED')) {
        console.error('Error checking Verdaccio status:', error);
      }
    }
  }

  throw new Error('Verdaccio failed to start');
}

function rebuildAll(): void {
  if (isRebuilding) {
    console.info('Rebuild already in progress...');
    return;
  }

  isRebuilding = true;
  console.info(`[${formatTime()}] Rebuilding and republishing...`);

  try {
    buildDevelop();
    unpublishLocal();
    publishLocal();
    console.info(`[${formatTime()}] Rebuild complete!`);
  } catch (error) {
    console.error(`[${formatTime()}] Rebuild failed:`, error);
  } finally {
    isRebuilding = false;
  }
}

async function start(): Promise<void> {
  try {
    console.info('Starting watch mode for library development\n');
    await startVerdaccio();
    buildDevelop();
    unpublishLocal();
    publishLocal();

    const libsDir = join(process.cwd(), 'libs');
    await setupFileWatchers([libsDir]);

    console.info('Watch mode ready!');
    console.info('Local packages published to http://localhost:4873');
    console.info('Watching for file changes in libs/');
    console.info('Libraries will auto-rebuild on changes');
    console.info('Press Ctrl+C to stop');

    await new Promise(() => undefined);
  } catch (error) {
    console.error('Fatal:', error);
    killChildProcesses();
    process.exit(1);
  }
}

process.on('SIGINT', () => {
  console.log('Shutting down...');
  killChildProcesses();
  process.exit(0);
});

start();
