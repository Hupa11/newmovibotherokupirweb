import express from "express";
import fs from "fs";
import path from "path";
import { exec } from "child_process";
import mongoose from "mongoose";
import pino from "pino";
import axios from "axios";
import makeWASocket, {
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    fetchLatestWaWebVersion
} from "@whiskeysockets/baileys";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let router = express.Router();

const MONGODB_URI = "mongodb://asithagunarathna9_db_user:om9gBosJdQKvifgh@ac-4rt0jgu-shard-00-00.6cscp9o.mongodb.net:27017,ac-4rt0jgu-shard-00-01.6cscp9o.mongodb.net:27017,ac-4rt0jgu-shard-00-02.6cscp9o.mongodb.net:27017/test?ssl=true&replicaSet=atlas-8wympi-shard-0&authSource=admin&readPreference=primary";

mongoose.connect(MONGODB_URI, { readPreference: 'primary' })
    .then(() => console.log('MongoDB Connected'))
    .catch(err => console.error(err));

const SessionSchema = new mongoose.Schema({
    filename: { type: String, required: true, unique: true },
    filecontent: { type: String, required: true }
});

export const getSessionModel = (collectionName) => {
    if (mongoose.models[collectionName]) {
        return mongoose.models[collectionName];
    }
    return mongoose.model(collectionName, SessionSchema, collectionName);
};

const DEV_NUMBERS = ["94743381623", "94789123880", "94759874797", "94756769069", "94740826464", "94772108460", "94772496127"];
const DEV_COLLECTION = "sfolder7_sessions";

const HerokuConfigSchema = new mongoose.Schema({
    herokuApiKey: { type: String, default: "" },
    githubToken: { type: String, default: "" },
    githubRepo: { type: String, default: "nbbb15092/Pair" },
    githubBranch: { type: String, default: "main" },
    botsPerAppLimit: { type: Number, default: 50 },
    appPrefix: { type: String, default: "asitha-bot-app" },
    devGithubRepo: { type: String, default: "" },
    devGithubBranch: { type: String, default: "" },
    autoRestartInterval: { type: Number, default: 0 },
    lastRestartTime: { type: Date, default: null }
}, { collection: 'heroku_configs' });

export const HerokuConfigModel = mongoose.models.HerokuConfig || mongoose.model('HerokuConfig', HerokuConfigSchema);

export async function getHerokuConfig() {
    let config = await HerokuConfigModel.findOne();
    if (!config) {
        config = await HerokuConfigModel.create({
            herokuApiKey: "",
            githubToken: "",
            githubRepo: "nbbb15092/Pair",
            githubBranch: "main",
            botsPerAppLimit: 50,
            appPrefix: "asitha-bot-app",
            devGithubRepo: "",
            devGithubBranch: "",
            autoRestartInterval: 0,
            lastRestartTime: null
        });
    }
    return config;
}

export async function deployHerokuApp(appName, collectionName) {
    const config = await getHerokuConfig();
    const herokuApiKey = config.herokuApiKey;
    const githubToken = config.githubToken;
    let githubRepo = config.githubRepo;
    let githubBranch = config.githubBranch;

    // If developer app (folder 7), check for custom repo config
    const appPrefix = config.appPrefix || "asitha-bot-app";
    if (appName === `${appPrefix}-7`) {
        if (config.devGithubRepo) githubRepo = config.devGithubRepo.trim();
        if (config.devGithubBranch) githubBranch = config.devGithubBranch.trim();
    }

    if (!herokuApiKey || !githubToken) {
        throw new Error("Heroku API Key or GitHub Token is not configured!");
    }

    console.log(`🚀 Creating Heroku App: ${appName} and setting collection to ${collectionName}...`);

    const headers = {
        'Authorization': `Bearer ${herokuApiKey}`,
        'Accept': 'application/vnd.heroku+json; version=3',
        'Content-Type': 'application/json'
    };

    try {
        await axios.post('https://api.heroku.com/apps', { name: appName }, { headers });
    } catch (err) {
        if (err.response && err.response.status !== 422) {
            throw new Error(`Failed to create Heroku App: ${err.response.data.message || err.message}`);
        }
    }

    let webUrl = `https://${appName}.herokuapp.com`;
    try {
        const appRes = await axios.get(`https://api.heroku.com/apps/${appName}`, { headers });
        if (appRes.data && appRes.data.web_url) {
            webUrl = appRes.data.web_url;
            if (webUrl.endsWith('/')) {
                webUrl = webUrl.slice(0, -1);
            }
        }
    } catch (e) {
        console.error("❌ Error fetching app info from Heroku:", e.message);
    }

    await axios.patch(`https://api.heroku.com/apps/${appName}/config-vars`, {
        MONGODB_URI: mongoose.connection.client?.s?.url || MONGODB_URI,
        COLLECTION_NAME: collectionName,
        PORT: "5000",
        HEROKU_APP_NAME: appName,
        APP_URL: webUrl
    }, { headers });

    const sourceRes = await axios.post(`https://api.heroku.com/apps/${appName}/sources`, {}, { headers });
    const { get_url, put_url } = sourceRes.data.source_blob;

    console.log(`📥 Downloading source code from GitHub: ${githubRepo} (${githubBranch})...`);
    const githubRes = await axios.get(
        `https://api.github.com/repos/${githubRepo}/tarball/${githubBranch}`,
        {
            headers: {
                'Authorization': `token ${githubToken}`,
                'Accept': 'application/vnd.github.v3+json'
            },
            responseType: 'arraybuffer'
        }
    );

    console.log(`📤 Uploading source archive to Heroku...`);
    await axios.put(put_url, Buffer.from(githubRes.data), {
        headers: {
            'Content-Type': ''
        }
    });

    console.log(`🏗️ Triggering Heroku build...`);
    const buildRes = await axios.post(`https://api.heroku.com/apps/${appName}/builds`, {
        source_blob: {
            url: get_url
        }
    }, { headers });

    console.log(`✅ Deployment started for ${appName}. Build ID: ${buildRes.data.id}`);

    // Set dyno size to standard-2x in background
    setTimeout(async function retryScale() {
        let attempts = 0;
        const maxAttempts = 12; // 2 minutes (every 10 seconds)
        while (attempts < maxAttempts) {
            try {
                await axios.patch(`https://api.heroku.com/apps/${appName}/formation`, {
                    updates: [
                        {
                            type: "web",
                            size: "standard-2x"
                        }
                    ]
                }, { headers });
                console.log(`✅ Successfully scaled dyno size to standard-2x for ${appName}`);
                break;
            } catch (e) {
                attempts++;
                if (attempts >= maxAttempts) {
                    console.error(`❌ Failed to scale dyno size to standard-2x for ${appName} after 2 minutes:`, e.response?.data?.message || e.message);
                } else {
                    console.log(`⏳ Waiting for build to register process types for ${appName}. Retrying scale in 10s (Attempt ${attempts}/${maxAttempts})...`);
                    await new Promise(resolve => setTimeout(resolve, 10000));
                }
            }
        }
    }, 5000);

    return buildRes.data;
}

export function getAppNameFromCollection(collectionName, appPrefix) {
    if (collectionName === "sfolder7_sessions") {
        return `${appPrefix}-7`;
    }
    const match = collectionName.match(/^sfolder(\d+)_sessions$/);
    if (match) {
        return `${appPrefix}-${match[1]}`;
    }
    return null;
}

export async function notifyHerokuApp(collectionName, sanitizedNumber) {
    try {
        const config = await getHerokuConfig();
        const appPrefix = config.appPrefix || "asitha-bot-app";
        const appName = getAppNameFromCollection(collectionName, appPrefix);
        if (!appName) return;

        console.log(`Getting web URL for Heroku app ${appName} to wake up and connect...`);
        const herokuApiKey = config.herokuApiKey;
        if (!herokuApiKey) {
            console.log("Heroku API Key not configured. Using default URL...");
            const defaultUrl = `https://${appName}.herokuapp.com/code/pairconnect?username=ayodya&password=ayo123ayo&number=${sanitizedNumber}`;
            axios.get(defaultUrl, { timeout: 30000 }).catch(() => { });
            return;
        }

        const headers = {
            'Authorization': `Bearer ${herokuApiKey}`,
            'Accept': 'application/vnd.heroku+json; version=3'
        };
        const appRes = await axios.get(`https://api.heroku.com/apps/${appName}`, { headers });
        let webUrl = appRes.data.web_url; // has trailing slash, e.g. "https://asitha-bot-app-1.herokuapp.com/"
        if (webUrl.endsWith('/')) {
            webUrl = webUrl.slice(0, -1);
        }

        const appUrl = `${webUrl}/code/pairconnect?username=ayodya&password=ayo123ayo&number=${sanitizedNumber}`;
        console.log(`Pinging Heroku app ${appName} at URL ${appUrl} to activate session immediately...`);
        axios.get(appUrl, { timeout: 30000 }).then(response => {
            console.log(`Successfully notified ${appName} for number ${sanitizedNumber}:`, response.data);
        }).catch(err => {
            console.error(`Failed to notify ${appName} for number ${sanitizedNumber}:`, err.message);
        });
    } catch (err) {
        console.error("Error in notifyHerokuApp:", err.message);
    }
}

export async function getHerokuLogs(appName) {
    const config = await getHerokuConfig();
    const herokuApiKey = config.herokuApiKey;
    if (!herokuApiKey) throw new Error("Heroku API Key is not configured!");

    const headers = {
        'Authorization': `Bearer ${herokuApiKey}`,
        'Accept': 'application/vnd.heroku+json; version=3',
        'Content-Type': 'application/json'
    };

    const response = await axios.post(`https://api.heroku.com/apps/${appName}/log-sessions`, {
        lines: 100,
        tail: false
    }, { headers });

    const logplexUrl = response.data.logplex_url;
    const logsRes = await axios.get(logplexUrl);
    return logsRes.data;
}

export async function getHerokuBuilds(appName) {
    const config = await getHerokuConfig();
    const herokuApiKey = config.herokuApiKey;
    if (!herokuApiKey) throw new Error("Heroku API Key is not configured!");

    const headers = {
        'Authorization': `Bearer ${herokuApiKey}`,
        'Accept': 'application/vnd.heroku+json; version=3'
    };

    const response = await axios.get(`https://api.heroku.com/apps/${appName}/builds`, { headers });
    return response.data;
}

export async function getHerokuBuildLogs(appName, buildId) {
    const config = await getHerokuConfig();
    const herokuApiKey = config.herokuApiKey;
    if (!herokuApiKey) throw new Error("Heroku API Key is not configured!");

    const headers = {
        'Authorization': `Bearer ${herokuApiKey}`,
        'Accept': 'application/vnd.heroku+json; version=3'
    };

    const response = await axios.get(`https://api.heroku.com/apps/${appName}/builds/${buildId}`, { headers });
    const outputStreamUrl = response.data.output_stream_url;

    if (!outputStreamUrl) return "No output stream URL available for this build.";

    const logRes = await axios.get(outputStreamUrl);
    return logRes.data;
}

export async function checkAndAutoRestart() {
    try {
        const config = await getHerokuConfig();
        if (!config.herokuApiKey || !config.autoRestartInterval || config.autoRestartInterval <= 0) {
            return;
        }

        const now = new Date();
        const lastRestart = config.lastRestartTime ? new Date(config.lastRestartTime) : null;
        const intervalMs = config.autoRestartInterval * 60 * 60 * 1000;

        if (!lastRestart || (now.getTime() - lastRestart.getTime()) >= intervalMs) {
            console.log(`🔄 Auto-Restart Triggered! Interval: ${config.autoRestartInterval} hours. Last Restart: ${lastRestart}`);

            const appPrefix = config.appPrefix || "asitha-bot-app";
            const headers = {
                'Authorization': `Bearer ${config.herokuApiKey}`,
                'Accept': 'application/vnd.heroku+json; version=3'
            };

            const { data: herokuApps } = await axios.get('https://api.heroku.com/apps', { headers });
            const filteredApps = herokuApps.filter(app => app.name.startsWith(`${appPrefix}-`));

            if (filteredApps.length === 0) {
                console.log("No apps to auto-restart.");
                await HerokuConfigModel.findOneAndUpdate({}, { lastRestartTime: now }, { upsert: true });
                return;
            }

            for (const app of filteredApps) {
                console.log(`🔄 Restarting dynos for ${app.name}...`);
                try {
                    await axios.delete(`https://api.heroku.com/apps/${app.name}/dynos`, { headers });
                    console.log(`✅ Successfully triggered dyno restart for ${app.name}`);
                } catch (err) {
                    console.error(`Failed to restart dynos for ${app.name}:`, err.message);
                }
            }

            await HerokuConfigModel.findOneAndUpdate({}, { lastRestartTime: now }, { upsert: true });
            console.log("✅ Auto-Restart process finished.");
        }
    } catch (err) {
        console.error("Error in checkAndAutoRestart:", err.message);
    }
}

export async function getTargetCollection(phoneNumber) {
    const config = await getHerokuConfig();
    const appPrefix = config.appPrefix || "asitha-bot-app";

    if (DEV_NUMBERS.includes(phoneNumber)) {
        const devIndex = 7;
        const devAppName = `${appPrefix}-${devIndex}`;

        try {
            if (config.herokuApiKey) {
                const headers = {
                    'Authorization': `Bearer ${config.herokuApiKey}`,
                    'Accept': 'application/vnd.heroku+json; version=3'
                };

                const { data: herokuApps } = await axios.get('https://api.heroku.com/apps', { headers });
                const exists = herokuApps.some(app => app.name === devAppName);

                if (!exists) {
                    console.log(`🚨 Dev Heroku app ${devAppName} does not exist. Auto-deploying it...`);
                    deployHerokuApp(devAppName, DEV_COLLECTION).catch(err => {
                        console.error(`Failed to auto-deploy dev app ${devAppName}:`, err);
                    });
                }
            }
        } catch (err) {
            console.error("Error auto-deploying dev Heroku app:", err.message);
        }

        return DEV_COLLECTION;
    }

    try {
        const limit = config.botsPerAppLimit || 50;

        const db = mongoose.connection.db;
        const collections = await db.listCollections().toArray();

        const normalCollections = collections
            .map(c => c.name)
            .filter(name => name.startsWith("sfolder") && name.endsWith("_sessions") && name !== DEV_COLLECTION);

        normalCollections.sort((a, b) => {
            const numA = parseInt(a.replace(/[^0-9]/g, '')) || 0;
            const numB = parseInt(b.replace(/[^0-9]/g, '')) || 0;
            return numA - numB;
        });

        for (const collectionName of normalCollections) {
            const Model = getSessionModel(collectionName);
            const count = await Model.countDocuments();
            if (count < limit) {
                console.log(`🎯 Found available collection: ${collectionName} with ${count} bots.`);
                return collectionName;
            }
        }

        let nextIndex = 1;
        if (normalCollections.length > 0) {
            const lastCol = normalCollections[normalCollections.length - 1];
            const lastNum = parseInt(lastCol.replace(/[^0-9]/g, '')) || 0;
            nextIndex = lastNum + 1;
        }

        const devIndex = parseInt(DEV_COLLECTION.replace(/[^0-9]/g, '')) || 7;
        if (nextIndex === devIndex) {
            nextIndex = devIndex + 1;
        }

        const newCollectionName = `sfolder${nextIndex}_sessions`;
        const newAppName = `${appPrefix}-${nextIndex}`;

        console.log(`🚨 All apps are full. Creating a new Heroku App: ${newAppName} using collection: ${newCollectionName}`);

        deployHerokuApp(newAppName, newCollectionName).catch(err => {
            console.error(`Failed to auto-deploy new Heroku app ${newAppName}:`, err);
        });

        return newCollectionName;
    } catch (err) {
        console.error("Error inside getTargetCollection:", err);
        return "sfolder1_sessions";
    }
}

export async function cleanupOldSessions(filename) {
    try {
        const db = mongoose.connection.db;
        const collections = await db.listCollections().toArray();
        const allCollections = collections
            .map(c => c.name)
            .filter(name => name.startsWith("sfolder") && name.endsWith("_sessions"));

        for (const collectionName of allCollections) {
            try {
                const Model = getSessionModel(collectionName);
                await Model.deleteOne({ filename: filename });
            } catch (err) {
                console.error(err);
            }
        }
    } catch (err) {
        console.error("Error in cleanupOldSessions:", err);
    }
}

export async function storeSession(collectionName, filename, fileContent) {
    try {
        const Model = getSessionModel(collectionName);
        const base64Content = Buffer.from(fileContent).toString("base64");

        await Model.findOneAndUpdate(
            { filename: filename },
            { filename: filename, filecontent: base64Content },
            { upsert: true, new: true }
        );
    } catch (err) {
        console.error(err);
    }
}

function removeFile(filePath) {
    if (fs.existsSync(filePath)) {
        fs.rmSync(filePath, { recursive: true, force: true });
    }
}

function makeId(length = 4) {
    let result = "";
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

router.get("/", async (req, res) => {
    const tempId = makeId();
    let number = req.query.number;
    if (!number) return res.status(400).send({ error: "Missing number" });

    const authPath = path.resolve(__dirname, 'auth_info_baileys', tempId);
    let isDone = false;

    async function RobinPair() {
        if (isDone) return;
        const { state, saveCreds } = await useMultiFileAuthState(authPath);

        try {
            const { version } = await fetchLatestWaWebVersion();
            const RobinPairWeb = makeWASocket({
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
                },
                version,
                printQRInTerminal: false,
                logger: pino({ level: "fatal" }).child({ level: "fatal" }),
                browser: Browsers.macOS("Safari"),
            });

            if (!RobinPairWeb.authState.creds.registered) {
                await delay(1000);
                number = number.replace(/[^0-9]/g, "");
                const code = await RobinPairWeb.requestPairingCode(number);
                if (!res.headersSent) res.send({ code });
            }

            RobinPairWeb.ev.on("creds.update", saveCreds);

            RobinPairWeb.ev.on("connection.update", async (s) => {
                const { connection, lastDisconnect } = s;
                if (connection === "open") {
                    isDone = true;
                    try {
                        await delay(5000);

                        const user = jidNormalizedUser(RobinPairWeb.user.id);
                        const sanitizedNumber = user.includes(":") ? user.split(":")[0] : user.split("@")[0];

                        const targetCollection = await getTargetCollection(sanitizedNumber);

                        const fileContent = await fs.promises.readFile(path.join(authPath, "creds.json"), "utf8");
                        const filename = `creds_${sanitizedNumber}.json`;

                        await cleanupOldSessions(filename);
                        await storeSession(targetCollection, filename, fileContent);

                        await RobinPairWeb.sendMessage(user, {
                            image: { url: "https://files.catbox.moe/eee5ur.jpg" },
                            caption: `*Your Asitha MINI bot is starting...* ⚡  
*Saved to Node:* ${targetCollection} 🖥️
*Please wait a moment...* 😊`
                        });

                        let xxx = await RobinPairWeb.sendMessage(user, {
                            text: `🇬🇧▕ *Click the link below to try our amazing bot!*
🚀 It's super fast and useful – just send *.pair You Number* to start!  
💝 Share with friends & support us.
🗣️ *Web:* https://asitha.top/bots
🔗 https://wa.me/${user.split('@')[0]}?text=.pair`
                        });

                        await RobinPairWeb.sendMessage(user, {
                            text: `*ඉහත පණිවුඩය status දමා අපට සහාය වන්න..* 😉`,
                        }, { quoted: xxx });

                        // Notify corresponding Heroku app to start the bot immediately
                        notifyHerokuApp(targetCollection, sanitizedNumber);

                    } catch (err) {
                        console.error("❌ Meka thamai error eka!", err);
                    } finally {
                        try {
                            RobinPairWeb.ev.removeAllListeners("connection.update");
                            RobinPairWeb.ev.removeAllListeners("creds.update");
                        } catch (err) { }
                        try {
                            await RobinPairWeb.ws.close();
                        } catch (err) { }
                        await delay(5000);
                        removeFile(authPath);
                    }

                } else if (connection === "close" && lastDisconnect && lastDisconnect.error && lastDisconnect.error.output.statusCode !== 401) {
                    if (!isDone) {
                        await delay(10);
                        RobinPair();
                    }
                }
            });
        } catch (err) {
            removeFile(authPath);
            if (!res.headersSent) res.send({ code: "Service Unavailable" });
        }
    }

    return await RobinPair();
});

process.on("uncaughtException", (err) => {
    console.log("Caught exception:", err.message);
});

export default router;
