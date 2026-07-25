import express from 'express';
import axios from 'axios';
import bodyParser from 'body-parser';
import { EventEmitter } from 'events';
import mongoose from 'mongoose';

// Local files import karaddi aniwaryen extension eka danna one (.js or .mjs)
import server from './qr.js';
import code, { HerokuConfigModel, getHerokuConfig, deployHerokuApp, getSessionModel, getHerokuLogs, getHerokuBuilds, getHerokuBuildLogs, checkAndAutoRestart } from './pair.js';

const app = express();
const path = process.cwd(); // process global nisa meka awulak na

const H_URL = "http://134.209.103.160:7860"; // main URL
const A_PATH = `/code/active?username=ayodya&password=ayo123ayo`; // active path
const R_PATH = `/code/connect?username=ayodya&password=ayo123ayo`; // reconnect path
const D_PATH = `/code/delsession?username=ayodya&password=ayo123ayo&number=`; // session delete path
const RN_PATH = `/code/pairconnect?username=ayodya&password=ayo123ayo&number=`; // pair connect number path

const PORT = process.env.PORT || 8000;

// EventEmitter setup eka MJS widihata
EventEmitter.defaultMaxListeners = 500;

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.use('/qr', server);
app.use('/code', code);

app.get('/active', async (req, res) => {
    try {
        const { data } = await axios.get(`${H_URL}${A_PATH}`);
        res.status(200).send({
            count: data
        });
    } catch (error) {
        console.error('Error fetching active session:', error);
        res.status(500).send({ error: 'Failed to fetch active session' });
    }
});

app.use('/qrcode', (req, res) => {
    res.sendFile(`${path}/qr.html`);
});

app.use('/paircode', (req, res) => {
    res.sendFile(`${path}/pair.html`);
});

// REACTJS VITE FILE ISSUE ON HEROKU!
app.use(express.static(`${path}/dist`));

app.use('/assets', express.static(`${path}/dist/assets`));

app.get('/', (req, res) => {
    res.sendFile(`${path}/dist/index.html`);
});

// Password Middleware
const verifyPassword = (req, res, next) => {
    const password = req.query.password || req.headers['x-password'] || req.body.password;
    if (password === 'Asitha2005b') {
        return next();
    }
    res.status(403).json({ error: 'Unauthorized: Invalid password' });
};

// Serve Dashboard
app.get('/dashboard', (req, res) => {
    res.sendFile(`${path}/dashboard.html`);
});

// GET configuration settings
app.get('/api/config', verifyPassword, async (req, res) => {
    try {
        const config = await getHerokuConfig();
        res.status(200).json({
            status: 'success',
            config: {
                herokuApiKey: config.herokuApiKey ? true : false,
                githubToken: config.githubToken ? true : false,
                githubRepo: config.githubRepo,
                githubBranch: config.githubBranch,
                botsPerAppLimit: config.botsPerAppLimit,
                appPrefix: config.appPrefix || "asitha-bot-app",
                devGithubRepo: config.devGithubRepo || "",
                devGithubBranch: config.devGithubBranch || "",
                autoRestartInterval: config.autoRestartInterval || 0
            }
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// POST update configuration settings
app.post('/api/config', verifyPassword, async (req, res) => {
    try {
        const { herokuApiKey, githubToken, githubRepo, githubBranch, botsPerAppLimit, appPrefix, devGithubRepo, devGithubBranch, autoRestartInterval } = req.body;

        const updateData = {};
        if (herokuApiKey !== undefined) updateData.herokuApiKey = herokuApiKey.trim();
        if (githubToken !== undefined) updateData.githubToken = githubToken.trim();
        if (githubRepo !== undefined) updateData.githubRepo = githubRepo.trim();
        if (githubBranch !== undefined) updateData.githubBranch = githubBranch.trim();
        if (botsPerAppLimit !== undefined) updateData.botsPerAppLimit = parseInt(botsPerAppLimit);
        if (appPrefix !== undefined) updateData.appPrefix = appPrefix.trim();
        if (devGithubRepo !== undefined) updateData.devGithubRepo = devGithubRepo.trim();
        if (devGithubBranch !== undefined) updateData.devGithubBranch = devGithubBranch.trim();
        if (autoRestartInterval !== undefined) updateData.autoRestartInterval = parseInt(autoRestartInterval);

        await HerokuConfigModel.findOneAndUpdate({}, updateData, { upsert: true, new: true });
        res.status(200).json({ status: 'success', message: 'Config updated successfully' });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// GET Heroku apps and bot count
app.get('/api/apps', verifyPassword, async (req, res) => {
    try {
        const config = await getHerokuConfig();
        if (!config.herokuApiKey) {
            return res.status(200).json({ status: 'success', apps: [] });
        }

        const appPrefix = config.appPrefix || "asitha-bot-app";
        const headers = {
            'Authorization': `Bearer ${config.herokuApiKey}`,
            'Accept': 'application/vnd.heroku+json; version=3'
        };

        const { data: herokuApps } = await axios.get('https://api.heroku.com/apps', { headers });
        const filteredApps = herokuApps.filter(app => app.name.startsWith(`${appPrefix}-`));

        const db = mongoose.connection.db;
        const collectionsList = await db.listCollections().toArray();
        const activeCollections = collectionsList.map(c => c.name);

        const apps = await Promise.all(filteredApps.map(async (app) => {
            const index = app.name.replace(`${appPrefix}-`, '');
            const collectionName = `sfolder${index}_sessions`;

            let botsCount = 0;
            if (activeCollections.includes(collectionName)) {
                try {
                    const Model = getSessionModel(collectionName);
                    botsCount = await Model.countDocuments({ filename: /^creds_.*\.json$/ });
                } catch (e) {
                    console.error(`Error counting collection ${collectionName}:`, e);
                }
            }

            return {
                id: app.id,
                name: app.name,
                status: app.maintenance ? 'maintenance' : 'active',
                collectionName,
                botsCount
            };
        }));

        apps.sort((a, b) => {
            const numA = parseInt(a.name.replace(/[^0-9]/g, '')) || 0;
            const numB = parseInt(b.name.replace(/[^0-9]/g, '')) || 0;
            return numA - numB;
        });

        res.status(200).json({ status: 'success', apps });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.response?.data?.message || err.message });
    }
});

// POST redeploy Heroku app
app.post('/api/apps/redeploy', verifyPassword, async (req, res) => {
    try {
        const { appName } = req.body;
        if (!appName) {
            return res.status(400).json({ status: 'error', message: 'App Name is required' });
        }

        const config = await getHerokuConfig();
        const appPrefix = config.appPrefix || "asitha-bot-app";
        const index = appName.replace(`${appPrefix}-`, '');
        const collectionName = `sfolder${index}_sessions`;

        const buildData = await deployHerokuApp(appName, collectionName);
        res.status(200).json({ status: 'success', buildId: buildData.id });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// POST delete Heroku app & delete Mongo collection sessions
app.post('/api/apps/delete', verifyPassword, async (req, res) => {
    try {
        const { appName, collectionName } = req.body;
        if (!appName || !collectionName) {
            return res.status(400).json({ status: 'error', message: 'App Name and Collection Name are required' });
        }

        const config = await getHerokuConfig();
        const headers = {
            'Authorization': `Bearer ${config.herokuApiKey}`,
            'Accept': 'application/vnd.heroku+json; version=3'
        };

        await axios.delete(`https://api.heroku.com/apps/${appName}`, { headers });

        // MongoDB session collection is preserved so it can be re-used/re-deployed later.

        res.status(200).json({ status: 'success', message: `App ${appName} deleted successfully (MongoDB collection preserved).` });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.response?.data?.message || err.message });
    }
});

// POST manually spawn/create app
app.post('/api/apps/create', verifyPassword, async (req, res) => {
    try {
        const config = await getHerokuConfig();
        if (!config.herokuApiKey) {
            throw new Error("Heroku API Key is not configured!");
        }

        const appPrefix = config.appPrefix || "asitha-bot-app";
        const headers = {
            'Authorization': `Bearer ${config.herokuApiKey}`,
            'Accept': 'application/vnd.heroku+json; version=3'
        };

        const { data: herokuApps } = await axios.get('https://api.heroku.com/apps', { headers });
        const filteredApps = herokuApps.filter(app => app.name.startsWith(`${appPrefix}-`));

        let nextIndex = 1;
        if (filteredApps.length > 0) {
            const indexes = filteredApps.map(app => {
                const num = parseInt(app.name.replace(`${appPrefix}-`, '')) || 0;
                return num;
            });
            nextIndex = Math.max(...indexes) + 1;
        }

        if (nextIndex === 7) {
            nextIndex = 8;
        }

        const newCollectionName = `sfolder${nextIndex}_sessions`;
        const newAppName = `${appPrefix}-${nextIndex}`;

        const buildData = await deployHerokuApp(newAppName, newCollectionName);
        res.status(200).json({ status: 'success', appName: newAppName, buildId: buildData.id });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// POST redistribute and balance sessions
app.post('/api/apps/redistribute', verifyPassword, async (req, res) => {
    try {
        const config = await getHerokuConfig();
        const limit = 30; // Enforce EXACTLY 30 bots max per folder

        const db = mongoose.connection.db;
        const collections = await db.listCollections().toArray();

        const DEV_COLLECTION = "sfolder7_sessions";
        const DEV_NUMBERS = ["94743381623", "94789123880", "94759874797", "94756769069", "94740826464", "94772108460", "94772496127"];

        const allCollections = collections
            .map(c => c.name)
            .filter(name => name.startsWith("sfolder") && name.endsWith("_sessions"));

        // 1. Fetch all session documents from all collections
        const allSessions = [];
        for (const colName of allCollections) {
            const Model = getSessionModel(colName);
            const docs = await Model.find({ filename: /^creds_.*\.json$/ }).read('primary');
            docs.forEach(doc => {
                allSessions.push({
                    filename: doc.filename,
                    filecontent: doc.filecontent
                });
            });
        }

        // 2. Remove duplicates keeping unique files
        const uniqueMap = new Map();
        allSessions.forEach(session => {
            uniqueMap.set(session.filename, session.filecontent);
        });

        // 3. Separate dev sessions from normal sessions
        const devSessions = [];
        const normalSessions = [];

        uniqueMap.forEach((filecontent, filename) => {
            const match = filename.match(/^creds_(\d+)\.json$/);
            const phoneNumber = match ? match[1] : "";

            if (DEV_NUMBERS.includes(phoneNumber)) {
                devSessions.push({ filename, filecontent });
            } else {
                normalSessions.push({ filename, filecontent });
            }
        });

        // 4. Clear ALL existing sfolder collections first so no leftover collections retain duplicate sessions
        for (const colName of allCollections) {
            try {
                await db.collection(colName).deleteMany({});
            } catch (clearErr) {
                console.error(`Error clearing collection ${colName}:`, clearErr.message);
            }
        }

        // 5. Restore Dev Sessions back to sfolder7_sessions
        if (devSessions.length > 0) {
            const devCol = db.collection(DEV_COLLECTION);
            const devOps = devSessions.map(s => ({
                updateOne: {
                    filter: { filename: s.filename },
                    update: { $set: { filename: s.filename, filecontent: s.filecontent } },
                    upsert: true
                }
            }));
            await devCol.bulkWrite(devOps);
        }

        // 6. Re-calculate number of collections needed for normal sessions
        const numCollectionsNeeded = Math.max(1, Math.ceil(normalSessions.length / limit));

        // 7. Redistribute normal sessions into collections using upserts
        let colIndex = 1;
        for (let i = 0; i < numCollectionsNeeded; i++) {
            if (colIndex === 7) {
                colIndex = 8;
            }
            const startIdx = i * limit;
            const endIdx = startIdx + limit;
            const chunk = normalSessions.slice(startIdx, endIdx);

            const colName = `sfolder${colIndex}_sessions`;
            const col = db.collection(colName);

            if (chunk.length > 0) {
                await col.deleteMany({});
                const ops = chunk.map(s => ({
                    updateOne: {
                        filter: { filename: s.filename },
                        update: { $set: { filename: s.filename, filecontent: s.filecontent } },
                        upsert: true
                    }
                }));
                await col.bulkWrite(ops);
            }
            colIndex++;
        }

        // 6. Check Heroku apps list and trigger deploys/re-deploys for all active collections
        let deployedAppsCount = 0;
        if (config.herokuApiKey) {
            const appPrefix = config.appPrefix || "asitha-bot-app";
            const headers = {
                'Authorization': `Bearer ${config.herokuApiKey}`,
                'Accept': 'application/vnd.heroku+json; version=3'
            };

            const { data: herokuApps } = await axios.get('https://api.heroku.com/apps', { headers });
            const activeAppNames = herokuApps.map(app => app.name);

            let appIndex = 1;
            for (let i = 0; i < numCollectionsNeeded; i++) {
                if (appIndex === 7) {
                    appIndex = 8;
                }
                const appName = `${appPrefix}-${appIndex}`;
                const colName = `sfolder${appIndex}_sessions`;

                console.log(`🤖 Redistributor: Deploying/Redeploying app ${appName} for ${colName}...`);
                deployHerokuApp(appName, colName).catch(err => {
                    console.error(`Failed to deploy/redeploy app ${appName} during redistribution:`, err.message);
                });
                deployedAppsCount++;
                appIndex++;
            }

            // Developer App Check (sfolder7_sessions) only if dev sessions exist
            if (devSessions.length > 0) {
                const devAppName = `${appPrefix}-7`;
                const devColName = "sfolder7_sessions";
                console.log(`🤖 Redistributor: Deploying developer app ${devAppName}...`);
                deployHerokuApp(devAppName, devColName).catch(err => {
                    console.error(`Failed to deploy developer app ${devAppName} during redistribution:`, err.message);
                });
                deployedAppsCount++;
            }
        }

        res.status(200).json({
            status: 'success',
            uniqueSessions: uniqueMap.size,
            collectionsCount: numCollectionsNeeded,
            appsCount: numCollectionsNeeded,
            newlyDeployed: deployedAppsCount
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// POST redeploy all Heroku apps
app.post('/api/apps/redeploy-all', verifyPassword, async (req, res) => {
    try {
        const config = await getHerokuConfig();
        if (!config.herokuApiKey) {
            throw new Error("Heroku API Key is not configured!");
        }

        const appPrefix = config.appPrefix || "asitha-bot-app";
        const headers = {
            'Authorization': `Bearer ${config.herokuApiKey}`,
            'Accept': 'application/vnd.heroku+json; version=3'
        };

        const { data: herokuApps } = await axios.get('https://api.heroku.com/apps', { headers });
        const filteredApps = herokuApps.filter(app => app.name.startsWith(`${appPrefix}-`));

        if (filteredApps.length === 0) {
            return res.status(200).json({ status: 'success', message: 'No active Heroku apps found to redeploy.', appsCount: 0, apps: [] });
        }

        console.log(`🔄 Triggering bulk redeployment for ${filteredApps.length} apps...`);

        const results = [];
        for (const app of filteredApps) {
            const appName = app.name;
            const index = appName.replace(`${appPrefix}-`, '');
            const collectionName = `sfolder${index}_sessions`;

            console.log(`🏗️ Bulk Redeploying ${appName}...`);
            deployHerokuApp(appName, collectionName).catch(err => {
                console.error(`Failed to redeploy ${appName} in bulk:`, err.message);
            });
            results.push(appName);
        }

        res.status(200).json({ status: 'success', appsCount: results.length, apps: results });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// GET runtime logs for a specific Heroku app
app.get('/api/apps/:appName/logs', verifyPassword, async (req, res) => {
    try {
        const { appName } = req.params;
        const logs = await getHerokuLogs(appName);
        res.status(200).json({ status: 'success', logs });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// GET recent builds list for a specific Heroku app
app.get('/api/apps/:appName/builds', verifyPassword, async (req, res) => {
    try {
        const { appName } = req.params;
        const builds = await getHerokuBuilds(appName);
        res.status(200).json({ status: 'success', builds });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// GET build logs for a specific build of a Heroku app
app.get('/api/apps/:appName/builds/:buildId/logs', verifyPassword, async (req, res) => {
    try {
        const { appName, buildId } = req.params;
        const logs = await getHerokuBuildLogs(appName, buildId);
        res.status(200).json({ status: 'success', logs });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// Start the periodic auto-restart check
checkAndAutoRestart(); // run once on startup
setInterval(checkAndAutoRestart, 5 * 60 * 1000); // run every 5 minutes

//====================================

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});

export default app;
