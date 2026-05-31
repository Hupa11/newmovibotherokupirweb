import express from 'express';
import axios from 'axios';
import bodyParser from 'body-parser';
import { EventEmitter } from 'events';
import mongoose from 'mongoose';

// Local files import karaddi aniwaryen extension eka danna one (.js or .mjs)
import server from './qr.js'; 
import code, { HerokuConfigModel, getHerokuConfig, deployHerokuApp, getSessionModel } from './pair.js';

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
                botsPerAppLimit: config.botsPerAppLimit
            }
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// POST update configuration settings
app.post('/api/config', verifyPassword, async (req, res) => {
    try {
        const { herokuApiKey, githubToken, githubRepo, githubBranch, botsPerAppLimit } = req.body;
        
        const updateData = {};
        if (herokuApiKey !== undefined) updateData.herokuApiKey = herokuApiKey;
        if (githubToken !== undefined) updateData.githubToken = githubToken;
        if (githubRepo !== undefined) updateData.githubRepo = githubRepo;
        if (githubBranch !== undefined) updateData.githubBranch = githubBranch;
        if (botsPerAppLimit !== undefined) updateData.botsPerAppLimit = parseInt(botsPerAppLimit);

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

        const headers = {
            'Authorization': `Bearer ${config.herokuApiKey}`,
            'Accept': 'application/vnd.heroku+json; version=3'
        };

        const { data: herokuApps } = await axios.get('https://api.heroku.com/apps', { headers });
        const filteredApps = herokuApps.filter(app => app.name.startsWith('asitha-bot-app-'));

        const db = mongoose.connection.db;
        const collectionsList = await db.listCollections().toArray();
        const activeCollections = collectionsList.map(c => c.name);

        const apps = await Promise.all(filteredApps.map(async (app) => {
            const indexMatch = app.name.match(/asitha-bot-app-(\d+)/);
            const index = indexMatch ? indexMatch[1] : '';
            const collectionName = `sfolder${index}_sessions`;

            let botsCount = 0;
            if (activeCollections.includes(collectionName)) {
                try {
                    const Model = getSessionModel(collectionName);
                    botsCount = await Model.countDocuments();
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

        const indexMatch = appName.match(/asitha-bot-app-(\d+)/);
        const index = indexMatch ? indexMatch[1] : '';
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

        try {
            const db = mongoose.connection.db;
            await db.dropCollection(collectionName);
        } catch (e) {
            console.error(`Collection ${collectionName} drop error:`, e.message);
        }

        res.status(200).json({ status: 'success', message: `App ${appName} deleted successfully.` });
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

        const headers = {
            'Authorization': `Bearer ${config.herokuApiKey}`,
            'Accept': 'application/vnd.heroku+json; version=3'
        };

        const { data: herokuApps } = await axios.get('https://api.heroku.com/apps', { headers });
        const filteredApps = herokuApps.filter(app => app.name.startsWith('asitha-bot-app-'));

        let nextIndex = 1;
        if (filteredApps.length > 0) {
            const indexes = filteredApps.map(app => {
                const match = app.name.match(/asitha-bot-app-(\d+)/);
                return match ? parseInt(match[1]) : 0;
            });
            nextIndex = Math.max(...indexes) + 1;
        }

        const newCollectionName = `sfolder${nextIndex}_sessions`;
        const newAppName = `asitha-bot-app-${nextIndex}`;

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
        const limit = config.botsPerAppLimit || 50;

        const db = mongoose.connection.db;
        const collections = await db.listCollections().toArray();
        
        const DEV_COLLECTION = "sfolder7_sessions";
        const sessionCollections = collections
            .map(c => c.name)
            .filter(name => name.startsWith("sfolder") && name.endsWith("_sessions") && name !== DEV_COLLECTION);

        // 1. Fetch all session documents from all collections
        const allSessions = [];
        for (const colName of sessionCollections) {
            const Model = getSessionModel(colName);
            const docs = await Model.find({});
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

        const uniqueSessions = [];
        uniqueMap.forEach((filecontent, filename) => {
            uniqueSessions.push({ filename, filecontent });
        });

        // 3. Re-calculate number of collections needed
        const numCollectionsNeeded = Math.max(1, Math.ceil(uniqueSessions.length / limit));

        // 4. Drop all existing session collections
        for (const colName of sessionCollections) {
            try {
                await db.dropCollection(colName);
            } catch (dropErr) {
                console.error(`Error dropping collection ${colName}:`, dropErr.message);
            }
        }

        // 5. Redistribute unique sessions into new collections
        for (let i = 0; i < numCollectionsNeeded; i++) {
            const startIdx = i * limit;
            const endIdx = startIdx + limit;
            const chunk = uniqueSessions.slice(startIdx, endIdx);
            
            const colName = `sfolder${i + 1}_sessions`;
            const Model = getSessionModel(colName);
            
            if (chunk.length > 0) {
                await Model.insertMany(chunk);
            }
        }

        // 6. Check Heroku apps list and trigger deploys for missing ones
        let deployedAppsCount = 0;
        if (config.herokuApiKey) {
            const headers = {
                'Authorization': `Bearer ${config.herokuApiKey}`,
                'Accept': 'application/vnd.heroku+json; version=3'
            };

            const { data: herokuApps } = await axios.get('https://api.heroku.com/apps', { headers });
            const activeAppNames = herokuApps.map(app => app.name);

            for (let i = 0; i < numCollectionsNeeded; i++) {
                const appName = `asitha-bot-app-${i + 1}`;
                const colName = `sfolder${i + 1}_sessions`;

                if (!activeAppNames.includes(appName)) {
                    console.log(`🤖 Redistributor: Automatically deploying missing app ${appName}`);
                    deployHerokuApp(appName, colName).catch(err => {
                        console.error(`Failed to auto-deploy app ${appName} during redistribution:`, err.message);
                    });
                    deployedAppsCount++;
                }
            }
        }

        res.status(200).json({
            status: 'success',
            uniqueSessions: uniqueSessions.length,
            collectionsCount: numCollectionsNeeded,
            appsCount: numCollectionsNeeded,
            newlyDeployed: deployedAppsCount
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

//====================================

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});

export default app;
