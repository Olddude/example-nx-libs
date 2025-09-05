import process from 'node:process';
import { spawn, type ChildProcess } from 'node:child_process';
import { get } from 'node:http';

let verdaccioProcess: ChildProcess | undefined;
let unpublishProcess: ChildProcess | undefined;
let publishProcess: ChildProcess | undefined;

function killChildProcesses() {
  verdaccioProcess?.kill();
  unpublishProcess?.kill();
  publishProcess?.kill();
}

process.on('SIGINT', () => {
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
          console.log('Verdaccio is ready!');
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
      console.log('Starting Verdaccio...');
      verdaccioProcess = spawn('npm', ['run', 'verdaccio'], { stdio: 'inherit' });
      
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

function startUnpublish(): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      console.log('Starting unpublish process...');
      unpublishProcess = spawn('npm', ['run', 'unpublish:local'], { stdio: 'inherit' });
      
      unpublishProcess.on('error', (error) => {
        console.error('Unpublish process error:', error);
        reject(error);
      });

      unpublishProcess.on('exit', (code) => {
        if (code === 0) {
          console.log('Unpublish completed successfully');
          resolve();
        } else {
          console.error(`Unpublish process exited with code ${code}`);
          resolve(); // Still resolve to continue with publish
        }
      });
      
    } catch (error) {
      console.error('Error starting unpublish process:', error);
      reject(error);
    }
  });
}

function startPublish(): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      console.log('Starting publish process...');
      publishProcess = spawn('npm', ['run', 'publish:local'], { stdio: 'inherit' });
      
      publishProcess.on('error', (error) => {
        console.error('Publish process error:', error);
        reject(error);
      });

      publishProcess.on('exit', (code) => {
        if (code === 0) {
          console.log('Publish completed successfully');
          resolve();
        } else {
          console.error(`Publish process exited with code ${code}`);
          reject(new Error(`Publish failed with code ${code}`));
        }
      });
      
    } catch (error) {
      console.error('Error starting publish process:', error);
      reject(error);
    }
  });
}

async function watch() {
  try {
    await startVerdaccio();
    await startUnpublish();
    await startPublish();
    console.info('All processes completed successfully');
    if (verdaccioProcess && !verdaccioProcess.killed) {
      console.info('Verdaccio is still running. Press Ctrl+C to exit.');
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      await new Promise(() => {}); // This will wait indefinitely
    }
  } catch (error) {
    console.error('Fatal:', error);
    killChildProcesses();
    process.exit(1);
  }
}

watch();
