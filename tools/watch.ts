import process from 'node:process';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { get } from 'node:http';
import { watch } from 'node:fs';
import { join, relative } from 'node:path';
import { readdir } from 'node:fs/promises';

let verdaccioProcess: ChildProcess | undefined;
let isRebuilding = false;
let rebuildTimer: NodeJS.Timeout | undefined;

function parseCommandLineArguments() {
  const args = process.argv.slice(2);
  let username = '';
  let password = '';
  let email = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--username' && args[i + 1]) {
      username = args[++i];
    } else if (args[i] === '--password' && args[i + 1]) {
      password = args[++i];
    } else if (args[i] === '--email' && args[i + 1]) {
      email = args[++i];
    }
  }

  if (!username || !password || !email) {
    console.error('Missing required arguments!');
    console.error('Usage: node -r ts-node/register watch.ts --username <username> --password <password> --email <email>');
    process.exit(1);
  }

  return { username, password, email }; 
}

const { username, password, email } = parseCommandLineArguments();

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

function addUser(): void {
  try {
    execSync(`npm adduser --registry http://localhost:4873/ --username ${username} --password ${password} --email ${email}`, {
      stdio: 'inherit',
      encoding: 'utf8',
      timeout: 2000
    });
  } catch (error) {
    console.error('Failed to register user:', error);
  }
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
  } catch (error: any) {
    // Log detailed error information
    if (error.stdout) {
      console.info('Stdout:', error.stdout);
    }
    if (error.stderr) {
      console.info('Stderr:', error.stderr);
    }
    if (error.code !== 0) {
      console.info(`Unpublish command exited with code ${error.code}`);
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
  } catch (error: any) {
    const errorMsg = error.message || error.toString() || '';
    if (errorMsg.includes('cannot publish over the previously published versions') || 
        errorMsg.includes('You cannot publish over')) {
      console.log('Packages already exist at this version, skipping publish');
    } else {
      console.error('Publish completed with warnings');
    }
  }
}

function buildDevelop(): void {
  try {
    console.info('Building libraries...');
    execSync('npx nx run-many --target=build --all --configuration=development --parallel --output-style=stream --no-cloud', {
      stdio: 'inherit',
      encoding: 'utf8',
      timeout: 120000
    });
    console.info('Build completed');
  } catch (error: any) {
    console.error('Build failed:', error.message);
    throw new Error(`Build failed: ${error.message}`);
  }
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
    console.info(`Username: ${username}`);
    console.info(`Email: ${email}`);

    await startVerdaccio();
    addUser();
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
