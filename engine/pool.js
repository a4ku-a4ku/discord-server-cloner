const crypto = require('crypto');
const { EnhancedServerCloner } = require('./cloner');

class ClonerQueuePool {
    constructor(maxConcurrent = 10) {
        this.maxConcurrent = parseInt(process.env.MAX_CONCURRENT_CLONERS || maxConcurrent, 10);
        this.activeJobs = new Map(); // jobId -> JobObject
        this.queuedJobs = []; // Array of JobObjects
        this.historyJobs = new Map(); // jobId -> Summary
        this.eventListeners = new Map(); // jobId -> Set of SSE response streams
        this.jobLogs = new Map(); // jobId -> Array of log items
    }

    generateId() {
        return 'clone-' + crypto.randomBytes(6).toString('hex');
    }

    getStats() {
        return {
            activeCount: this.activeJobs.size,
            maxConcurrent: this.maxConcurrent,
            queuedCount: this.queuedJobs.length,
            totalProcessed: this.historyJobs.size
        };
    }

    enqueue(options) {
        const jobId = this.generateId();
        const job = {
            jobId,
            options,
            status: 'QUEUED',
            submitTime: Date.now(),
            startTime: null,
            endTime: null,
            cloner: null,
            error: null,
            progress: 0,
            step: 'IN_QUEUE',
            stats: {
                rolesCreated: 0,
                channelsCreated: 0,
                emojisCreated: 0,
                failed: 0
            }
        };

        this.jobLogs.set(jobId, []);
        this.eventListeners.set(jobId, new Set());

        if (this.activeJobs.size < this.maxConcurrent) {
            this.startJob(job);
        } else {
            this.queuedJobs.push(job);
            const position = this.queuedJobs.length;
            this.emitLog(jobId, {
                type: 'info',
                message: `Server busy (${this.activeJobs.size}/${this.maxConcurrent} active slots). Placed in queue at position #${position}.`,
                step: 'QUEUED',
                percent: 0
            });
            this.broadcastQueuePositions();
        }

        return {
            jobId,
            status: job.status,
            queuePosition: job.status === 'QUEUED' ? this.queuedJobs.indexOf(job) + 1 : 0,
            activeSlots: `${this.activeJobs.size}/${this.maxConcurrent}`
        };
    }

    broadcastQueuePositions() {
        this.queuedJobs.forEach((job, index) => {
            const position = index + 1;
            this.emit(job.jobId, 'queue_update', {
                position,
                totalQueued: this.queuedJobs.length,
                activeSlots: `${this.activeJobs.size}/${this.maxConcurrent}`,
                estimatedWaitSeconds: position * 90
            });
        });
    }

    async startJob(job) {
        job.status = 'RUNNING';
        job.startTime = Date.now();
        this.activeJobs.set(job.jobId, job);

        const cloner = new EnhancedServerCloner((event) => {
            job.progress = event.percent;
            job.step = event.step;
            if (event.stats) job.stats = event.stats;
            this.emitLog(job.jobId, event);
        });

        job.cloner = cloner;

        this.emit(job.jobId, 'status', {
            status: 'RUNNING',
            step: 'INITIALIZING',
            percent: 5,
            message: 'Active execution slot assigned! Initializing Discord connection...'
        });

        try {
            await cloner.run(job.options);
            job.status = cloner.isAborted ? 'ABORTED' : 'COMPLETED';
            job.progress = 100;
        } catch (err) {
            job.status = 'FAILED';
            job.error = err.message;
        } finally {
            job.endTime = Date.now();
            this.activeJobs.delete(job.jobId);
            this.archiveJob(job);

            this.emit(job.jobId, 'finish', {
                status: job.status,
                error: job.error,
                durationMs: job.endTime - job.startTime,
                stats: job.stats
            });

            // Process next job in queue immediately
            this.processNextInQueue();
        }
    }

    processNextInQueue() {
        if (this.queuedJobs.length > 0 && this.activeJobs.size < this.maxConcurrent) {
            const nextJob = this.queuedJobs.shift();
            this.broadcastQueuePositions();
            this.startJob(nextJob);
        }
    }

    abort(jobId) {
        // If in queue, remove directly
        const queueIdx = this.queuedJobs.findIndex(j => j.jobId === jobId);
        if (queueIdx !== -1) {
            const [job] = this.queuedJobs.splice(queueIdx, 1);
            job.status = 'ABORTED';
            job.endTime = Date.now();
            this.archiveJob(job);
            this.emit(jobId, 'finish', { status: 'ABORTED', message: 'Job cancelled while in queue.' });
            this.broadcastQueuePositions();
            return { ok: true, message: 'Job successfully removed from queue.' };
        }

        // If currently running, signal cloner
        const activeJob = this.activeJobs.get(jobId);
        if (activeJob) {
            if (activeJob.cloner) {
                activeJob.cloner.abort();
            }
            return { ok: true, message: 'Abort signal sent to active cloner worker.' };
        }

        return { ok: false, message: 'Job ID not found or already finished.' };
    }

    archiveJob(job) {
        this.historyJobs.set(job.jobId, {
            jobId: job.jobId,
            status: job.status,
            submitTime: job.submitTime,
            startTime: job.startTime,
            endTime: job.endTime,
            durationSec: job.startTime ? Math.round((job.endTime - job.startTime) / 1000) : 0,
            stats: job.stats,
            error: job.error
        });

        // Limit memory of history to last 50 jobs
        if (this.historyJobs.size > 50) {
            const firstKey = this.historyJobs.keys().next().value;
            this.historyJobs.delete(firstKey);
            this.jobLogs.delete(firstKey);
            this.eventListeners.delete(firstKey);
        }
    }

    getJobStatus(jobId) {
        if (this.activeJobs.has(jobId)) {
            const job = this.activeJobs.get(jobId);
            return {
                jobId,
                status: job.status,
                step: job.step,
                percent: job.progress,
                stats: job.stats,
                durationSec: Math.round((Date.now() - job.startTime) / 1000),
                inQueue: false
            };
        }

        const queueIndex = this.queuedJobs.findIndex(j => j.jobId === jobId);
        if (queueIndex !== -1) {
            return {
                jobId,
                status: 'QUEUED',
                queuePosition: queueIndex + 1,
                totalQueued: this.queuedJobs.length,
                activeSlots: `${this.activeJobs.size}/${this.maxConcurrent}`,
                inQueue: true
            };
        }

        if (this.historyJobs.has(jobId)) {
            return {
                ...this.historyJobs.get(jobId),
                inQueue: false,
                finished: true
            };
        }

        return null;
    }

    subscribe(jobId, res) {
        if (!this.eventListeners.has(jobId)) {
            this.eventListeners.set(jobId, new Set());
        }
        const listeners = this.eventListeners.get(jobId);
        listeners.add(res);

        // Send existing logs
        const pastLogs = this.jobLogs.get(jobId) || [];
        pastLogs.forEach(entry => {
            res.write(`event: log\ndata: ${JSON.stringify(entry)}\n\n`);
        });

        // Send current status
        const status = this.getJobStatus(jobId);
        if (status) {
            res.write(`event: status\ndata: ${JSON.stringify(status)}\n\n`);
        }

        // Clean up when connection closes
        res.on('close', () => {
            listeners.delete(res);
        });
    }

    emitLog(jobId, event) {
        const logs = this.jobLogs.get(jobId);
        if (logs) {
            logs.push(event);
            if (logs.length > 500) logs.shift(); // keep last 500 lines
        }
        this.emit(jobId, 'log', event);
    }

    emit(jobId, eventName, data) {
        const listeners = this.eventListeners.get(jobId);
        if (listeners) {
            const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
            listeners.forEach(res => {
                try {
                    res.write(payload);
                } catch (e) {}
            });
        }
    }

    getActiveJobsSummary() {
        const active = Array.from(this.activeJobs.values()).map(j => ({
            jobId: j.jobId,
            status: j.status,
            step: j.step,
            percent: j.progress,
            durationSec: Math.round((Date.now() - j.startTime) / 1000),
            stats: j.stats,
            targetGuildId: j.options?.targetGuildId,
            sourceGuildId: j.options?.sourceGuildId
        }));
        return {
            active,
            queuedCount: this.queuedJobs.length,
            activeCount: this.activeJobs.size,
            maxConcurrent: this.maxConcurrent
        };
    }

    forceResetAll() {
        for (const [jobId, job] of this.activeJobs) {
            try {
                if (job.cloner) job.cloner.abort();
            } catch (e) {}
            this.emit(jobId, 'finish', { status: 'ABORTED', message: 'Engine force reset by user.' });
        }
        this.activeJobs.clear();
        this.queuedJobs.length = 0;
        return { ok: true, message: 'All slots cleared and reset to IDLE.' };
    }
}

const pool = new ClonerQueuePool();

module.exports = { pool, ClonerQueuePool };
