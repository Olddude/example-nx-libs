import process from 'node:process';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { get } from 'node:http';

let verdaccioProcess: ChildProcess | undefined;

function killChildProcesses() {
  verdaccioProcess?.kill();
}

process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down...');
  killChildProcesses();
  process.exit(0);
});

function waitForVerdaccio(maxAttempts = 30): Promise<void> {
  return new Promise((resolve, reject) => {
    let attempts = 0;

    const checkHealth = () => {
      attempts++;
      get('http://localhost:4873/-/ping', (res) => {
        if (res.statusCode === 200) {
          console.log('✅ Verdaccio is ready!');
          resolve();
        } else {
          retry();
        }
      }).on('error', () => {
        retry();
      });
    };

    const retry = () => {
      if (attempts >= maxAttempts) {
        reject(new Error('Verdaccio failed to start'));
      } else {
        setTimeout(checkHealth, 1000);
      }
    };

    setTimeout(checkHealth, 1000);
  });
}

function startVerdaccio(): Promise<void> {
  // eslint-disable-next-line no-async-promise-executor
  return new Promise(async (resolve, reject) => {
    try {
      console.log('🚀 Starting Verdaccio local registry...');
      verdaccioProcess = spawn('npx', ['verdaccio', '-c', 'verdaccio.yaml'], { 
        stdio: 'inherit',
        shell: true 
      });
      
      verdaccioProcess.on('error', (error) => {
        console.error('Verdaccio process error:', error);
        if (!error.message.includes('EADDRINUSE')) {
          reject(error);
        }
      });

      await waitForVerdaccio();
      resolve();
      
    } catch (error) {
      console.error('Error starting Verdaccio:', error);
      reject(error);
    }
  });
}

function unpublish(): void {
  try {
    console.log('🧹 Cleaning up previous packages from local registry...');
    execSync('npx nx run-many --target=unpublish-local --all --parallel', { 
      stdio: 'ignore', // Completely ignore output to prevent hanging
      encoding: 'utf8',
      timeout: 30000 // 30 second timeout to prevent indefinite hanging
    });
    console.log('✅ Cleanup completed');
  } catch (error: any) {
    // Silently continue - packages might not exist yet which is normal
    // This is expected behavior for first run or after registry cleanup
    // Also catches timeout errors if unpublish takes too long
    console.log('📦 No previous packages to clean up (this is normal for first run)');
  }
}

function publish(): void {
  try {
    console.log('📦 Publishing packages to local registry...');
    execSync('npx nx run-many --target=publish-local --all --parallel', { 
      stdio: 'inherit',
      encoding: 'utf8',
      timeout: 60000 // 60 second timeout
    });
    console.log('✅ All packages published successfully!');
  } catch (error: any) {
    console.error('❌ Publish failed:', error.message);
    throw new Error(`Publish failed: ${error.message}`);
  }
}

function buildLibs(): void {
  try {
    console.log('🔨 Building libraries...');
    execSync('npx nx run-many --target=build --all --configuration=development --parallel', {
      stdio: 'inherit',
      encoding: 'utf8',
      timeout: 120000 // 2 minute timeout for builds
    });
    console.log('✅ Build completed');
  } catch (error: any) {
    console.error('❌ Build failed:', error.message);
    throw new Error(`Build failed: ${error.message}`);
  }
}

async function watch() {
  try {
    console.log('🚀 Starting watch mode for library development\n');
    
    // Start Verdaccio
    await startVerdaccio();
    
    // Build libraries first
    buildLibs();
    
    // Clean up any existing packages
    unpublish();
    
    // Publish fresh packages
    publish();
    
    console.info('\n✨ Watch mode ready!');
    console.info('📦 Local packages are published to Verdaccio at http://localhost:4873');
    console.info('🔄 You can now use these packages in your applications');
    console.info('⌨️  Press Ctrl+C to stop\n');
    
    if (verdaccioProcess && !verdaccioProcess.killed) {
      // Keep the process running
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      await new Promise(() => {}); // This will wait indefinitely
    }
  } catch (error) {
    console.error('❌ Fatal error:', error);
    killChildProcesses();
    process.exit(1);
  }
}

watch();
