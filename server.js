require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { pool } = require('./engine/pool');

const app = express();
const PORT = process.env.PORT || 3002;

app.use(cors());
app.use(express.json());

// Defense-in-depth security headers
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Content-Security-Policy', 
        "default-src 'self'; " +
        "script-src 'self' 'unsafe-inline'; " +
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
        "font-src 'self' https://fonts.gstatic.com; " +
        "img-src 'self' data: https:; " +
        "connect-src 'self';"
    );
    next();
});

// Serve static frontend assets
app.use(express.static(path.join(__dirname, 'public')));

// Global pool telemetry
app.get('/api/pool-stats', (req, res) => {
    res.json({ ok: true, ...pool.getStats() });
});

// Telemetry for active jobs
app.get('/api/active-job', (req, res) => {
    res.json({ ok: true, ...pool.getActiveJobsSummary() });
});

// Force reset all slots
app.post('/api/force-reset', (req, res) => {
    const result = pool.forceResetAll();
    res.json({ ok: true, ...result });
});

// Uptime monitor & health check endpoints
app.get(['/health', '/ping', '/api/health'], (req, res) => {
    res.status(200).json({ ok: true, status: 'healthy', uptime: process.uptime(), timestamp: Date.now() });
});

// Enqueue a new cloning job
app.post('/api/clone', (req, res) => {
    const {
        token,
        sourceGuildId,
        targetGuildId,
        rolesMode = 'delete_and_clone',
        channelsMode = 'delete_and_clone',
        emojisMode = 'delete_and_clone',
        copyServerInfo = true
    } = req.body;

    if (!token || typeof token !== 'string' || token.trim().length < 20) {
        return res.status(400).json({ ok: false, error: 'Valid Discord user token is required.' });
    }

    if (!targetGuildId || !/^\d{16,21}$/.test(targetGuildId.trim())) {
        return res.status(400).json({ ok: false, error: 'Valid 17-20 digit Target Server ID is required.' });
    }

    const requiresSource = (
        rolesMode !== 'delete_only' ||
        channelsMode !== 'delete_only' ||
        emojisMode !== 'delete_only' ||
        copyServerInfo
    );

    if (requiresSource && (!sourceGuildId || !/^\d{16,21}$/.test(sourceGuildId.trim()))) {
        return res.status(400).json({ ok: false, error: 'Valid 17-20 digit Source Server ID is required for cloning actions.' });
    }

    if (sourceGuildId && sourceGuildId.trim() === targetGuildId.trim()) {
        return res.status(400).json({ ok: false, error: 'Source Server ID and Target Server ID cannot be identical.' });
    }

    try {
        const result = pool.enqueue({
            token: token.trim(),
            sourceGuildId: sourceGuildId ? sourceGuildId.trim() : null,
            targetGuildId: targetGuildId.trim(),
            rolesMode,
            channelsMode,
            emojisMode,
            copyServerInfo: Boolean(copyServerInfo)
        });

        res.json({
            ok: true,
            jobId: result.jobId,
            status: result.status,
            queuePosition: result.queuePosition,
            activeSlots: result.activeSlots,
            message: result.status === 'RUNNING' 
                ? 'Active slot assigned! Task initialized.' 
                : `Placed in queue at position #${result.queuePosition}. Will auto-start when slot frees up.`
        });
    } catch (err) {
        res.status(500).json({ ok: false, error: 'Internal server error while scheduling cloning task: ' + err.message });
    }
});

// Server-Sent Events (SSE) stream for real-time progress & terminal logs
app.get('/api/stream/:jobId', (req, res) => {
    const { jobId } = req.params;
    const status = pool.getJobStatus(jobId);
    if (!status) {
        return res.status(404).json({ ok: false, error: 'Job ID not found.' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    pool.subscribe(jobId, res);

    // Keepalive heartbeat every 15s to prevent cloud proxy timeouts
    const heartbeat = setInterval(() => {
        try {
            res.write(': keepalive\n\n');
        } catch (e) {
            clearInterval(heartbeat);
        }
    }, 15000);

    res.on('close', () => {
        clearInterval(heartbeat);
    });
});

// Polling status fallback
app.get('/api/status/:jobId', (req, res) => {
    const { jobId } = req.params;
    const status = pool.getJobStatus(jobId);
    if (!status) {
        return res.status(404).json({ ok: false, error: 'Job ID not found.' });
    }
    res.json({ ok: true, ...status });
});

// Abort active or queued job
app.post('/api/abort/:jobId', (req, res) => {
    const { jobId } = req.params;
    const result = pool.abort(jobId);
    res.json(result);
});

// Fallback for SPA routing
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log('============================================================');
    console.log('⚡ A4KU Discord Server Cloner Engine v2.0');
    console.log(`🌐 Live Dashboard:  http://localhost:${PORT}`);
    console.log(`🚀 Concurrency:     ${pool.maxConcurrent} active slots (FIFO queueing)`);
    console.log('🛡️  Rate Limiting:   Automatic 429 Exponential Backoff Active');
    console.log('============================================================');
});
