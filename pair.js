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

const MONGODB_URI = "mongodb+srv://asithagunarathna9_db_user:om9gBosJdQKvifgh@moviebot.6cscp9o.mongodb.net/"; 

mongoose.connect(MONGODB_URI)
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

const DEV_NUMBERS = ["94743381623", "94759874797","94756769069","94740826464", "94772108460"];
const DEV_COLLECTION = "sfolder7_sessions";

const HerokuConfigSchema = new mongoose.Schema({
    herokuApiKey: { type: String, default: "" },
    githubToken: { type: String, default: "" },
    githubRepo: { type: String, default: "nbbb15092/Pair" },
    githubBranch: { type: String, default: "main" },
    botsPerAppLimit: { type: Number, default: 50 }
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
            botsPerAppLimit: 50
        });
    }
    return config;
}

export async function deployHerokuApp(appName, collectionName) {
    const config = await getHerokuConfig();
    const herokuApiKey = config.herokuApiKey;
    const githubToken = config.githubToken;
    const githubRepo = config.githubRepo;
    const githubBranch = config.githubBranch;

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

    await axios.patch(`https://api.heroku.com/apps/${appName}/config-vars`, {
        MONGODB_URI: mongoose.connection.client?.s?.url || MONGODB_URI,
        COLLECTION_NAME: collectionName,
        PORT: "5000"
    }, { headers });

    const sourceRes = await axios.post(`https://api.heroku.com/apps/${appName}/sources`, {}, { headers });
    const { get_url, put_url } = sourceRes.data.source_blob;

    console.log(`📥 Downloading source code from GitHub: ${githubRepo}...`);
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
    return buildRes.data;
}

export async function getTargetCollection(phoneNumber) {
  if (DEV_NUMBERS.includes(phoneNumber)) {
    const devIndex = 7;
    const devAppName = `asitha-bot-app-${devIndex}`;
    
    try {
      const config = await getHerokuConfig();
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
    const config = await getHerokuConfig();
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

    const newCollectionName = `sfolder${nextIndex}_sessions`;
    const newAppName = `asitha-bot-app-${nextIndex}`;

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

  async function RobinPair() {
    const { state, saveCreds } = await useMultiFileAuthState(`./auth_info_baileys/${tempId}`);

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
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
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
          try {
            await delay(5000);
            
            const user = jidNormalizedUser(RobinPairWeb.user.id);
            const sanitizedNumber = user.includes(":") ? user.split(":")[0] : user.split("@")[0];

            const targetCollection = await getTargetCollection(sanitizedNumber);

            const authPath = path.join(__dirname, `./auth_info_baileys/${tempId}`);
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

          } catch (err) {
            console.error("❌ Meka thamai error eka!", err);
          } finally {
            await delay(100);
            try { await RobinPairWeb.ws.close(); } catch {}
            removeFile(`./auth_info_baileys/${tempId}`);
          }

        } else if (connection === "close" && lastDisconnect && lastDisconnect.error && lastDisconnect.error.output.statusCode !== 401) {
          await delay(10);
          RobinPair();
        }
      });
    } catch (err) {
      removeFile(`./auth_info_baileys/${tempId}`);
      if (!res.headersSent) res.send({ code: "Service Unavailable" });
    }
  }

  return await RobinPair();
});

process.on("uncaughtException", (err) => {
  console.log("Caught exception:", err.message);
});

export default router;
