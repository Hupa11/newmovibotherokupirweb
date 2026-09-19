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

            let cleanUrl = app.web_url || `https://${app.name}.herokuapp.com`;
            if (cleanUrl.endsWith('/')) cleanUrl = cleanUrl.slice(0, -1);

            return {
                id: app.id,
                name: app.name,
                webUrl: cleanUrl,
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
        let msg = err.response?.data?.message || err.message;
        if (err.response?.status === 401 || String(err.message).includes('401') || String(msg).includes('Bad credentials')) {
            msg = "GitHub Token Expired or Invalid (401 Bad credentials). Please update GitHub Token in Dashboard Settings!";
        }
        res.status(500).json({ status: 'error', message: msg });
    }
});

// POST restart single Heroku app dynos
app.post('/api/apps/restart', verifyPassword, async (req, res) => {
    try {
        const { appName } = req.body;
        if (!appName) {
            return res.status(400).json({ status: 'error', message: 'App Name is required' });
        }

        const config = await getHerokuConfig();
        if (!config.herokuApiKey) {
            throw new Error("Heroku API Key is not configured in Settings!");
        }

        const headers = {
            'Authorization': `Bearer ${config.herokuApiKey}`,
            'Accept': 'application/vnd.heroku+json; version=3'
        };

        console.log(`🔄 Restarting dynos for ${appName}...`);
        await axios.delete(`https://api.heroku.com/apps/${appName}/dynos`, { headers });
        console.log(`✅ Successfully restarted dynos for ${appName}`);

        res.status(200).json({ status: 'success', message: `Dynos successfully restarted for ${appName}. Bots are reconnecting.` });
    } catch (err) {
        console.error(`Failed to restart dynos for ${appName}:`, err.message);
        res.status(500).json({ status: 'error', message: err.response?.data?.message || err.message });
    }
});

// POST restart all Heroku apps dynos with safe spacing
app.post('/api/apps/restart-all', verifyPassword, async (req, res) => {
    try {
        const config = await getHerokuConfig();
        if (!config.herokuApiKey) {
            throw new Error("Heroku API Key is not configured in Settings!");
        }

        const appPrefix = config.appPrefix || "asitha-bot-app";
        const headers = {
            'Authorization': `Bearer ${config.herokuApiKey}`,
            'Accept': 'application/vnd.heroku+json; version=3'
        };

        const { data: herokuApps } = await axios.get('https://api.heroku.com/apps', { headers });
        const filteredApps = herokuApps
            .filter(app => app.name.startsWith(`${appPrefix}-`))
            .sort((a, b) => {
                const numA = parseInt(a.name.replace(`${appPrefix}-`, ''), 10) || 0;
                const numB = parseInt(b.name.replace(`${appPrefix}-`, ''), 10) || 0;
                return numA - numB;
            });

        if (filteredApps.length === 0) {
            return res.status(200).json({ status: 'success', message: 'No active Heroku apps found to restart.', appsCount: 0, apps: [] });
        }

        console.log(`🔄 Triggering bulk dyno restart for ${filteredApps.length} apps with 500ms spacing...`);

        // Run sequential restart in background with safe 500ms delay to prevent Heroku rate-limits
        (async () => {
            for (let i = 0; i < filteredApps.length; i++) {
                const app = filteredApps[i];
                try {
                    console.log(`[${i + 1}/${filteredApps.length}] Restarting dynos for ${app.name}...`);
                    await axios.delete(`https://api.heroku.com/apps/${app.name}/dynos`, { headers });
                } catch (e) {
                    console.error(`Failed to restart ${app.name}:`, e.message);
                }
                await new Promise(r => setTimeout(r, 500));
            }
            console.log(`✅ Bulk restart completed for all ${filteredApps.length} apps.`);
        })();

        res.status(200).json({
            status: 'success',
            message: `Restart initiated for ${filteredApps.length} applications with staggered timeouts.`,
            appsCount: filteredApps.length,
            apps: filteredApps.map(a => a.name)
        });
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

// POST delete all Heroku apps matching prefix (sessions preserved)
app.post('/api/apps/delete-all', verifyPassword, async (req, res) => {
    try {
        const config = await getHerokuConfig();
        if (!config.herokuApiKey) {
            throw new Error("Heroku API Key is not configured in Settings!");
        }

        const appPrefix = config.appPrefix || "asitha-bot-app";
        const headers = {
            'Authorization': `Bearer ${config.herokuApiKey}`,
            'Accept': 'application/vnd.heroku+json; version=3'
        };

        const { data: herokuApps } = await axios.get('https://api.heroku.com/apps', { headers });
        const filteredApps = herokuApps
            .filter(app => app.name.startsWith(`${appPrefix}-`))
            .sort((a, b) => {
                const numA = parseInt(a.name.replace(`${appPrefix}-`, ''), 10) || 0;
                const numB = parseInt(b.name.replace(`${appPrefix}-`, ''), 10) || 0;
                return numA - numB;
            });

        if (filteredApps.length === 0) {
            return res.status(200).json({ status: 'success', message: 'No managed Heroku apps found to delete.', deletedCount: 0, deletedApps: [] });
        }

        console.log(`🚨 Triggering bulk deletion for ${filteredApps.length} apps with 400ms spacing...`);

        const deletedApps = [];
        const failedApps = [];
        for (let i = 0; i < filteredApps.length; i++) {
            const app = filteredApps[i];
            try {
                console.log(`[${i + 1}/${filteredApps.length}] Deleting app ${app.name}...`);
                await axios.delete(`https://api.heroku.com/apps/${app.name}`, { headers });
                deletedApps.push(app.name);
            } catch (e) {
                console.error(`Failed to delete ${app.name}:`, e.message);
                failedApps.push({ app: app.name, error: e.message });
            }
            await new Promise(r => setTimeout(r, 400));
        }

        console.log(`✅ Bulk delete completed: ${deletedApps.length} deleted, ${failedApps.length} failed.`);

        res.status(200).json({
            status: 'success',
            message: `Successfully deleted ${deletedApps.length} applications (MongoDB sessions preserved).`,
            deletedCount: deletedApps.length,
            deletedApps,
            failedApps
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
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

            const appsToDeploy = [];
            let appIndex = 1;
            for (let i = 0; i < numCollectionsNeeded; i++) {
                if (appIndex === 7) {
                    appIndex = 8;
                }
                appsToDeploy.push({
                    appName: `${appPrefix}-${appIndex}`,
                    colName: `sfolder${appIndex}_sessions`,
                    isDev: false
                });
                appIndex++;
            }

            if (devSessions.length > 0) {
                appsToDeploy.push({
                    appName: `${appPrefix}-7`,
                    colName: "sfolder7_sessions",
                    isDev: true
                });
            }

            deployedAppsCount = appsToDeploy.length;

            console.log(`🚀 Redistributor: Starting sequential background deployment for ${appsToDeploy.length} apps with cached source buffer and 8s spacing...`);

            // Sequential background deployment worker with cached tarball & retries
            (async () => {
                let cachedStandardBuffer = null;
                for (let i = 0; i < appsToDeploy.length; i++) {
                    const item = appsToDeploy[i];
                    console.log(`🏗️ [${i + 1}/${appsToDeploy.length}] Redistributor deploying ${item.appName} (${item.colName})...`);

                    let success = false;
                    for (let attempt = 1; attempt <= 2; attempt++) {
                        try {
                            const bufToUse = item.isDev ? null : cachedStandardBuffer;
                            const buildData = await deployHerokuApp(item.appName, item.colName, bufToUse);
                            if (!item.isDev && !cachedStandardBuffer && buildData?._sourceBuffer) {
                                cachedStandardBuffer = buildData._sourceBuffer;
                            }
                            console.log(`✅ [${i + 1}/${appsToDeploy.length}] Build triggered successfully for ${item.appName}`);
                            success = true;
                            break;
                        } catch (err) {
                            console.error(`⚠️ [${i + 1}/${appsToDeploy.length}] Attempt ${attempt} failed for ${item.appName}:`, err.message);
                            if (attempt < 2) {
                                await new Promise(r => setTimeout(r, 4000));
                            }
                        }
                    }

                    if (i < appsToDeploy.length - 1) {
                        console.log(`⏳ Waiting 8s before deploying next app...`);
                        await new Promise(r => setTimeout(r, 8000));
                    }
                }
                console.log(`🏁 Redistributor finished all ${appsToDeploy.length} deployments.`);
            })();
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
            throw new Error("Heroku API Key is not configured in Settings!");
        }

        const appPrefix = config.appPrefix || "asitha-bot-app";
        const headers = {
            'Authorization': `Bearer ${config.herokuApiKey}`,
            'Accept': 'application/vnd.heroku+json; version=3'
        };

        const { data: herokuApps } = await axios.get('https://api.heroku.com/apps', { headers });
        const filteredApps = herokuApps
            .filter(app => app.name.startsWith(`${appPrefix}-`))
            .sort((a, b) => {
                const numA = parseInt(a.name.replace(`${appPrefix}-`, ''), 10) || 0;
                const numB = parseInt(b.name.replace(`${appPrefix}-`, ''), 10) || 0;
                return numA - numB;
            });

        if (filteredApps.length === 0) {
            return res.status(200).json({ status: 'success', message: 'No active Heroku apps found to redeploy.', appsCount: 0, apps: [] });
        }

        console.log(`🔄 Triggering sequential bulk redeployment for ${filteredApps.length} apps with 8s spacing...`);

        // Start background worker so API response doesn't time out
        (async () => {
            let cachedStandardBuffer = null;
            for (let i = 0; i < filteredApps.length; i++) {
                const app = filteredApps[i];
                const appName = app.name;
                const index = appName.replace(`${appPrefix}-`, '');
                const collectionName = `sfolder${index}_sessions`;
                const isDevApp = (index === '7');

                console.log(`🏗️ [${i + 1}/${filteredApps.length}] Bulk Redeploying ${appName}...`);
                try {
                    const bufToUse = isDevApp ? null : cachedStandardBuffer;
                    const buildData = await deployHerokuApp(appName, collectionName, bufToUse);
                    if (!isDevApp && !cachedStandardBuffer && buildData?._sourceBuffer) {
                        cachedStandardBuffer = buildData._sourceBuffer;
                    }
                    console.log(`✅ [${i + 1}/${filteredApps.length}] Build triggered successfully for ${appName}`);
                } catch (err) {
                    console.error(`❌ [${i + 1}/${filteredApps.length}] Failed to redeploy ${appName} in bulk:`, err.message);
                }

                // 8-second delay between app builds to prevent Heroku concurrency conflicts
                if (i < filteredApps.length - 1) {
                    console.log(`⏳ Waiting 8 seconds before triggering next app build...`);
                    await new Promise(r => setTimeout(r, 8000));
                }
            }
            console.log(`🏁 Bulk redeployment queue finished for all ${filteredApps.length} apps.`);
        })();

        res.status(200).json({
            status: 'success',
            message: `Initiated bulk updates for ${filteredApps.length} Heroku applications in sequence (8s timeout between apps).`,
            appsCount: filteredApps.length,
            apps: filteredApps.map(a => a.name)
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// POST fix unbuilt apps (detects apps with 0 builds or failed builds and deploys them)
app.post('/api/apps/fix-unbuilt', verifyPassword, async (req, res) => {
    try {
        const config = await getHerokuConfig();
        if (!config.herokuApiKey) {
            throw new Error("Heroku API Key is not configured in Settings!");
        }

        const appPrefix = config.appPrefix || "asitha-bot-app";
        const headers = {
            'Authorization': `Bearer ${config.herokuApiKey}`,
            'Accept': 'application/vnd.heroku+json; version=3'
        };

        const { data: herokuApps } = await axios.get('https://api.heroku.com/apps', { headers });
        const filteredApps = herokuApps
            .filter(app => app.name.startsWith(`${appPrefix}-`))
            .sort((a, b) => {
                const numA = parseInt(a.name.replace(`${appPrefix}-`, ''), 10) || 0;
                const numB = parseInt(b.name.replace(`${appPrefix}-`, ''), 10) || 0;
                return numA - numB;
            });

        if (filteredApps.length === 0) {
            return res.status(200).json({ status: 'success', message: 'No managed Heroku apps found.', count: 0, apps: [] });
        }

        console.log(`🔍 Checking builds status for ${filteredApps.length} apps...`);
        const unbuiltApps = [];

        for (const app of filteredApps) {
            try {
                const builds = await getHerokuBuilds(app.name);
                if (!builds || builds.length === 0) {
                    unbuiltApps.push(app.name);
                } else {
                    const latestBuild = builds[0];
                    if (latestBuild.status === 'failed') {
                        unbuiltApps.push(app.name);
                    }
                }
            } catch (e) {
                console.warn(`Could not fetch builds for ${app.name}:`, e.message);
                unbuiltApps.push(app.name);
            }
        }

        if (unbuiltApps.length === 0) {
            return res.status(200).json({ status: 'success', message: 'All apps already have active/successful builds!', count: 0, apps: [] });
        }

        console.log(`🚨 Found ${unbuiltApps.length} unbuilt/failed apps: ${unbuiltApps.join(', ')}. Triggering sequential builds...`);

        (async () => {
            let cachedStandardBuffer = null;
            for (let i = 0; i < unbuiltApps.length; i++) {
                const appName = unbuiltApps[i];
                const index = appName.replace(`${appPrefix}-`, '');
                const collectionName = `sfolder${index}_sessions`;
                const isDev = (index === '7');

                console.log(`🏗️ [${i + 1}/${unbuiltApps.length}] Building missing app ${appName}...`);
                try {
                    const bufToUse = isDev ? null : cachedStandardBuffer;
                    const buildData = await deployHerokuApp(appName, collectionName, bufToUse);
                    if (!isDev && !cachedStandardBuffer && buildData?._sourceBuffer) {
                        cachedStandardBuffer = buildData._sourceBuffer;
                    }
                    console.log(`✅ [${i + 1}/${unbuiltApps.length}] Build triggered for ${appName}`);
                } catch (err) {
                    console.error(`❌ Failed to build missing app ${appName}:`, err.message);
                }

                if (i < unbuiltApps.length - 1) {
                    await new Promise(r => setTimeout(r, 8000));
                }
            }
            console.log(`🏁 Finished building all ${unbuiltApps.length} previously unbuilt apps.`);
        })();

        res.status(200).json({
            status: 'success',
            message: `Identified and queued builds for ${unbuiltApps.length} unbuilt/failed apps.`,
            count: unbuiltApps.length,
            apps: unbuiltApps
        });
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
