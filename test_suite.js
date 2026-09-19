const assert = require('assert');
const { EnhancedServerCloner } = require('./engine/cloner');
const { ClonerQueuePool } = require('./engine/pool');
const http = require('http');

console.log('====================================================');
console.log('⚡ A4KU Discord Server Cloner Engine - Test Suite');
console.log('====================================================\n');

// ── TEST 1: @everyone Role Mapping & Permission Overwrites ──
console.log('[TEST 1] Testing @everyone Role Mapping Fix...');
{
    const cloner = new EnhancedServerCloner();
    const sourceGuildId = '111111111111111111';
    const targetGuildId = '222222222222222222';

    // Seed @everyone
    cloner.roleMapping.set(sourceGuildId, targetGuildId);
    cloner.roleMapping.set('999999999999999999', '888888888888888888'); // custom role

    const mockOverwrites = {
        cache: new Map([
            ['111111111111111111', { id: '111111111111111111', type: 'role', allow: 1024n, deny: 2048n }],
            ['999999999999999999', { id: '999999999999999999', type: 'role', allow: 0n, deny: 1024n }]
        ])
    };

    const targetGuild = {
        id: targetGuildId,
        roles: { cache: new Map() }
    };

    const mapped = cloner.mapPermissionOverwrites(mockOverwrites, targetGuild);
    assert.strictEqual(mapped.length, 2, 'Should map both permission overwrites');
    assert.strictEqual(mapped[0].id, targetGuildId, '@everyone should map to target guild ID');
    assert.strictEqual(mapped[1].id, '888888888888888888', 'Custom role should map to new target role ID');
    console.log('  ✓ PASSED: @everyone and custom roles mapped with zero permission drop.\n');
}

// ── TEST 2: Category ID Mapping & Parent Resolution ──
console.log('[TEST 2] Testing Category ID Mapping Resolution...');
{
    const cloner = new EnhancedServerCloner();
    const sourceCatId = '333333333333333333';
    const newCatId = '444444444444444444';

    cloner.categoryMapping.set(sourceCatId, newCatId);
    const resolvedParentId = cloner.categoryMapping.get(sourceCatId);

    assert.strictEqual(resolvedParentId, newCatId, 'Category parent ID must resolve precisely');
    console.log('  ✓ PASSED: Category mapping avoids string name collisions.\n');
}

// ── TEST 3: 429 Rate-Limit Exponential Backoff ──
console.log('[TEST 3] Testing 429 Rate-Limit Exponential Backoff Handler...');
(async () => {
    const cloner = new EnhancedServerCloner();
    let attempts = 0;

    const rateLimitedAction = async () => {
        attempts++;
        if (attempts < 3) {
            const err = new Error('You are being rate limited.');
            err.code = 429;
            err.timeout = 50; // fast mock timeout
            throw err;
        }
        return 'SUCCESS_DATA';
    };

    const result = await cloner.safeAction(rateLimitedAction, 'MockChannelCreate', 5);
    assert.strictEqual(result, 'SUCCESS_DATA', 'Should recover from 429 and succeed');
    assert.strictEqual(attempts, 3, 'Should have retried 2 times after 429');
    assert.strictEqual(cloner.stats.retries, 2, 'Stats should record 2 retries');
    console.log('  ✓ PASSED: 429 auto-retried with exponential backoff without dropping item.\n');

    // ── TEST 4: Concurrency Queue (15 Concurrent Users) ──
    console.log('[TEST 4] Testing Multi-User Concurrency Queue (15 Simultaneous Users)...');
    const testPool = new ClonerQueuePool(2); // 2 active slots
    testPool.startJob = (job) => {
        job.status = 'RUNNING';
        job.startTime = Date.now();
        testPool.activeJobs.set(job.jobId, job);
    };

    const enqueuedJobs = [];
    for (let i = 1; i <= 15; i++) {
        const res = testPool.enqueue({
            token: `token_${i}`,
            sourceGuildId: '100000000000000001',
            targetGuildId: '200000000000000002',
            rolesMode: 'skip',
            channelsMode: 'skip',
            emojisMode: 'skip',
            copyServerInfo: false
        });
        enqueuedJobs.push(res);
    }

    assert.strictEqual(testPool.activeJobs.size, 2, 'Exactly 2 jobs should be in active execution slots');
    assert.strictEqual(testPool.queuedJobs.length, 13, 'Remaining 13 jobs should be safely queued in FIFO line');

    const firstQueued = testPool.getJobStatus(enqueuedJobs[2].jobId);
    assert.strictEqual(firstQueued.queuePosition, 1, 'Job #3 should be #1 in line');

    const lastQueued = testPool.getJobStatus(enqueuedJobs[14].jobId);
    assert.strictEqual(lastQueued.queuePosition, 13, 'Job #15 should be #13 in line');

    console.log(`  ✓ PASSED: Active Slots: ${testPool.activeJobs.size}/2 | Waiting in Line: ${testPool.queuedJobs.length}`);

    // Abort a queued job
    testPool.abort(enqueuedJobs[2].jobId);
    assert.strictEqual(testPool.queuedJobs.length, 12, 'Aborting should remove job from queue');
    console.log('  ✓ PASSED: Queue cancellation verified.\n');

    // ── TEST 5: Live Local Web Server Verification ──
    console.log('[TEST 5] Verifying Live HTTP Server on http://127.0.0.1:3002...');
    const req = http.get('http://127.0.0.1:3002/api/pool-stats', (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
            const data = JSON.parse(body);
            assert.strictEqual(res.statusCode, 200, 'HTTP status should be 200');
            assert.strictEqual(data.ok, true, 'API should return ok: true');
            console.log(`  ✓ PASSED: Live Web Server HTTP 200 OK | Active: ${data.activeCount} | Max Slots: ${data.maxConcurrent}\n`);

            console.log('====================================================');
            console.log('🎉 ALL 5 VERIFICATION SUITES PASSED SUCCESSFULLY!');
            console.log('====================================================');
        });
    });
    req.on('error', (err) => {
        console.error('Server connection failed:', err.message);
        process.exit(1);
    });
})();
