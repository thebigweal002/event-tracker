import { execSync } from 'child_process';
import path from 'path';

export default async () => {
  console.log('\n🚀 Starting test containers...');
  try {
    const composeFile = path.resolve(__dirname, '../docker-compose.test.yml');
    
    // Start containers
    execSync(`docker compose -f ${composeFile} up -d`, { stdio: 'inherit' });

    console.log('⏳ Waiting for services to be ready...');
    
    // Wait for DB to be healthy (using the healthy check defined in docker-compose)
    let dbReady = false;
    for (let i = 0; i < 30; i++) {
        try {
            const status = execSync(`docker inspect --format="{{json .State.Health.Status}}" event-tracker-db-test`).toString().trim();
            if (status === '"healthy"') {
                dbReady = true;
                break;
            }
        } catch {
            // Service might not be started yet
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    if (!dbReady) {
        throw new Error('Database failed to become healthy in time.');
    }

    console.log('✅ Test containers are ready.\n');
  } catch (error) {
    console.error('❌ Failed to start test containers:', error);
    process.exit(1);
  }
};
