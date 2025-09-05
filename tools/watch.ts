import process from 'node:process';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { get } from 'node:http';
import { watch } from 'node:fs';
import { join, relative } from 'node:path';
import { readdir } from 'node:fs/promises';

let verdaccioProcess: ChildProcess | undefined;
let isRebuilding = false;
let rebuildTimer: NodeJS.Timeout | undefined;

const IGNORED_PATTERNS = [
  'node_modules',
  'dist',
  '.git',
  '.nx',
  'tmp',
  '.angular',
  '.cache',
  '*.spec.ts',
  '*.spec.js',
  '*.test.ts',
  '*.test.js',
  '.DS_Store'
];

function shouldIgnore(path: string): boolean {
  return IGNORED_PATTERNS.some(pattern => {
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
  console.log(`\n[${formatTime()}] 📝 File changed: ${relativePath}`);
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
          rebuild();
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

  console.log(`👀 Watching ${watchers.size} directories for changes`);
}

async function startVerdaccio(): Promise<void> {
  console.log('🚀 Starting Verdaccio local registry...');
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

  // Wait for Verdaccio to be ready
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
        console.log('✅ Verdaccio is ready!');
        return;
      }
    } catch (error) {
      // Continue retrying
    }
  }
  
  throw new Error('Verdaccio failed to start');
}

function cleanRegistry(): void {
  try {
    console.log('🧹 Cleaning up previous packages...');
    const output = execSync('npx nx run-many --target=unpublish-local --all --parallel --output-style=stream --no-cloud', { 
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 30000
    });
    if (output) {
      console.log(output);
    }
    console.log('✅ Cleanup completed');
  } catch (error: any) {
    // Log detailed error information
    if (error.stdout) {
      console.log('Stdout:', error.stdout);
    }
    if (error.stderr) {
      console.log('Stderr:', error.stderr);
    }
    if (error.code !== 0) {
      console.log(`⚠️  Unpublish command exited with code ${error.code}`);
    }
    console.log('📦 No previous packages to clean up (this is normal on first run)');
  }
}

function publishPackages(): void {
  try {
    console.log('📦 Publishing packages to local registry...');
    execSync('npx nx run-many --target=publish-local --all --parallel --output-style=stream --no-cloud', { 
      stdio: 'inherit',
      encoding: 'utf8',
      timeout: 60000
    });
    console.log('✅ All packages published successfully!');
  } catch (error: any) {
    const errorMsg = error.message || error.toString() || '';
    if (errorMsg.includes('cannot publish over the previously published versions') || 
        errorMsg.includes('You cannot publish over')) {
      console.log('⚠️  Packages already exist at this version, skipping publish');
    } else {
      console.error('⚠️  Publish completed with warnings');
    }
  }
}

function buildLibraries(): void {
  try {
    console.log('🔨 Building libraries...');
    execSync('npx nx run-many --target=build --all --configuration=development --parallel --output-style=stream --no-cloud', {
      stdio: 'inherit',
      encoding: 'utf8',
      timeout: 120000
    });
    console.log('✅ Build completed');
  } catch (error: any) {
    console.error('❌ Build failed:', error.message);
    throw new Error(`Build failed: ${error.message}`);
  }
}

function rebuild(): void {
  if (isRebuilding) {
    console.log('⏳ Rebuild already in progress...');
    return;
  }

  isRebuilding = true;
  console.log(`\n[${formatTime()}] 🔄 Rebuilding and republishing...`);

  try {
    buildLibraries();
    cleanRegistry();
    publishPackages();
    console.log(`[${formatTime()}] ✨ Rebuild complete!\n`);
  } catch (error) {
    console.error(`[${formatTime()}] ❌ Rebuild failed:`, error);
  } finally {
    isRebuilding = false;
  }
}

async function startWatchMode(): Promise<void> {
  try {
    console.log('🚀 Starting watch mode for library development\n');
    
    await startVerdaccio();
    
    buildLibraries();
    cleanRegistry();
    publishPackages();
    
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
  console.log('\n🛑 Shutting down...');
  killChildProcesses();
  process.exit(0);
});

startWatchMode();
