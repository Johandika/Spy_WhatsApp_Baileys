require("dotenv").config();
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  WAMessageStubType,
  downloadMediaMessage,
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const express = require("express");
const qrcode = require("qrcode-terminal");
const fs = require("fs").promises;
const path = require("path");
const schedule = require("node-schedule");
const pino = require("pino");

const app = express();
const port = process.env.PORT || 3000;

const baseLogDir = path.join(__dirname, "logs");
const authDir = path.join(__dirname, "auth_info_baileys");
const blockedContactsDir = path.join(__dirname, "blocked_contacts");

const activeCalls = new Map();
let sock;
const callTimestamps = new Map(); // <-- Deklarasi dipindahkan ke sini

// --- FUNGSI HELPER LENGKAP ---

async function ensureDirExists(dirPath) {
  try {
    await fs.access(dirPath);
  } catch (e) {
    await fs.mkdir(dirPath, { recursive: true });
  }
}

function getMessageBody(msg) {
  return (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    ""
  );
}

async function getContactName(contactId, sock) {
  try {
    const contact = await sock.contact.getContact(contactId);
    console.log("contaaaaaact", contact);
    console.log("contactId", contactId);
    return contact && (contact.name || contact.verifiedName)
      ? `${contact.name || contact.verifiedName} (${contactId})`
      : contactId;
  } catch (e) {
    return contactId;
  }
}

// log message
async function logMessage(msg) {
  try {
    if (!msg.message) return;
    const now = new Date();
    const timestamp = now.toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
    const dateString = `${now.getFullYear()}-${String(
      now.getMonth() + 1
    ).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const isIncoming = !msg.key.fromMe;
    const contactId = msg.key.remoteJid;
    const safeContactId = contactId.replace(/[^a-zA-Z0-9]/g, "_");
    const messageBody = getMessageBody(msg.message);
    const dailyLogDir = path.join(baseLogDir, safeContactId, dateString);
    await ensureDirExists(dailyLogDir);
    const logFileName = path.join(dailyLogDir, "messages.log");
    let logEntryText = messageBody;
    const mediaMessage =
      msg.message.imageMessage ||
      msg.message.videoMessage ||
      msg.message.audioMessage ||
      msg.message.documentMessage;
    if (mediaMessage) {
      const mediaBuffer = await downloadMediaMessage(
        msg,
        "buffer",
        {},
        {
          logger: pino({ level: "silent" }),
          reuploadRequest: makeWASocket.getAggregateVotesInPollMessage,
        }
      );
      const mediaDir = path.join(dailyLogDir, "media");
      await ensureDirExists(mediaDir);
      const timeString = now.toTimeString().slice(0, 8).replace(/:/g, "-");
      const extension = mediaMessage.mimetype.split("/")[1] || "dat";
      const fileName = mediaMessage.fileName || `media.${extension}`;
      const mediaFileName = `${timeString}_${fileName}`;
      const mediaFilePath = path.join(mediaDir, mediaFileName);
      await fs.writeFile(mediaFilePath, mediaBuffer);
      const relativeMediaPath = path.join("media", mediaFileName);
      logEntryText =
        `[MEDIA DISIMPAN: ${relativeMediaPath}] ${messageBody}`.trim();
    }
    if (!logEntryText) return;
    const botNumber = sock.user.id.split(":")[0] + "@s.whatsapp.net";
    const fromLabel = isIncoming ? `USER: ${contactId}` : `BOT: ${botNumber}`;
    const fromLabel2 = isIncoming ? `${contactId}` : `BOT`;
    const toLabel = isIncoming ? `BOT: ${botNumber}` : `USER: ${contactId}`;
    const toLabel2 = isIncoming ? `BOT` : `${contactId}`;
    const logEntry = `Waktu: ${timestamp}\nDari: ${fromLabel}\nUntuk: ${toLabel}\nPesan: ${logEntryText}\n\n---\n\n`;

    console.log(
      `[PESAN] ${timestamp} | ${fromLabel2} - ${toLabel2} | ${logEntryText}`
    );

    await fs.appendFile(logFileName, logEntry);
  } catch (error) {
    if (!error.message.includes("media")) {
      console.error("[ERROR] Terjadi kesalahan pada fungsi logMessage:", error);
    }
  }
}

// log panggilan
async function logCall(callType, contactId, sock, durationText = "") {
  try {
    const now = new Date();
    const timestamp = now.toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
    const dateString = `${now.getFullYear()}-${String(
      now.getMonth() + 1
    ).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const safeContactId = contactId.replace(/[^a-zA-Z0-9]/g, "_");
    const dailyLogDir = path.join(baseLogDir, safeContactId, dateString);
    await ensureDirExists(dailyLogDir);
    const callLogFile = path.join(dailyLogDir, "calls.log");
    const durationInfo = durationText ? ` | Durasi: ${durationText}` : "";

    let contactName = await getContactName(contactId, sock);

    const logEntry = `Waktu: ${timestamp} | Tipe: ${callType} | Kontak: ${contactName}${durationInfo}\n`;
    await fs.appendFile(callLogFile, logEntry);
    console.log(
      `[PANGGILAN] ${timestamp} | ${callType} | ${contactName} telah dicatat.`
    );
  } catch (error) {
    console.error("[GAGAL] Gagal menyimpan log panggilan!", error);
  }
}

// log  list realtime block unblock
async function logBlockedOrUnblockedContact(contactId, action) {
  try {
    await ensureDirExists(blockedContactsDir);
    const blockedLogPath = path.join(blockedContactsDir, "blocked_actions.log");
    const now = new Date();
    const timestamp = now.toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
    const logEntry = `Waktu: ${timestamp} | Aksi: ${action} | Kontak: ${contactId}\n`;
    await fs.appendFile(blockedLogPath, logEntry, "utf8");
    console.log(
      `[SUKSES] Log aksi "${action}" untuk ${contactId} telah dicatat.`
    );
  } catch (error) {
    console.error(
      `[GAGAL] Gagal menyimpan log aksi blokir untuk ${contactId}:`,
      error
    );
  }
}

// Menyimpan list kontak di block
async function saveBlockedContactsToFile() {
  try {
    if (!sock) {
      console.log("[INFO] Socket belum terinisialisasi.");
      return;
    }
    await ensureDirExists(blockedContactsDir);
    const blockedList = await sock.fetchBlocklist();
    const blockedLogPath = path.join(blockedContactsDir, "blocked.log");

    const now = new Date();
    const timestamp = now.toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
    let logEntry = "";

    if (blockedList && blockedList.length > 0) {
      logEntry += `Waktu: ${timestamp}\nKontak Diblokir:\n`;
      blockedList.forEach((jid) => {
        logEntry += `- ${jid}\n`;
      });
    } else {
      logEntry += `Waktu: ${timestamp}\nTidak ada nomor yang diblokir.\n`;
    }
    logEntry += `\n---\n\n`;

    await fs.appendFile(blockedLogPath, logEntry, "utf8");
    console.log(
      `[SUKSES] Daftar nomor yang diblokir telah ditambahkan ke: ${blockedLogPath}`
    );
  } catch (error) {
    console.error("[GAGAL] Gagal menyimpan daftar nomor yang diblokir:", error);
  }
}

let lastBlockedList = [];

async function startSock() {
  console.log("Menginisialisasi client WhatsApp (Baileys)...");
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    browser: ["Windows", "Chrome", "100.0.0"],
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("Pindai QR code ini (atau gunakan pairing code di bawah):");
      qrcode.generate(qr, { small: true });

      const phoneNumber = process.env.PHONE_NUMBER;
      if (phoneNumber) {
        const pairingCode = await sock.requestPairingCode(phoneNumber);
        if (pairingCode) {
          console.log(
            `\nSilakan masukkan kode 8 digit ini di aplikasi WhatsApp Anda:`
          );
          console.log(`\n    **${pairingCode}**\n`);
          console.log(`Atau buka tautan ini di browser:`);
          console.log(`\n    **https://wa.me/pair/${pairingCode}**\n`);
        }
      }
    }

    // logic reconnect
    if (connection === "close") {
      const shouldReconnect =
        (lastDisconnect.error instanceof Boom)?.output?.statusCode !==
        DisconnectReason.loggedOut;
      if (shouldReconnect) startSock();
    } else if (connection === "open") {
      console.log("Bot pencatat arsip media siap digunakan! 🗂️");
      lastBlockedList = await sock.fetchBlocklist();
      await saveBlockedContactsToFile(); // jalanin save block list di awal
    }
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("blocklist.update", async (update) => {
    console.log("[INFO] Perubahan pada daftar blokir terdeteksi!");
    const currentBlockedList = await sock.fetchBlocklist();

    // Filter untuk menemukan kontak yang baru diblokir
    const newlyBlocked = currentBlockedList.filter(
      (jid) => !lastBlockedList.includes(jid)
    );

    // Filter untuk menemukan kontak yang baru dibuka blokirnya
    const unblocked = lastBlockedList.filter(
      (jid) => !currentBlockedList.includes(jid)
    );

    // Catat log untuk kontak yang baru diblokir
    for (const jid of newlyBlocked) {
      await logBlockedOrUnblockedContact(jid, "diblokir");
    }

    // Catat log untuk kontak yang dibuka blokirnya
    for (const jid of unblocked) {
      await logBlockedOrUnblockedContact(jid, "dibuka blokir");
    }

    // Perbarui daftar blokir terakhir
    lastBlockedList = currentBlockedList;
  });

  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages[0];
    if (!msg || !msg.key) return;

    if (msg.message?.call) {
      const contactId = msg.key.remoteJid;
      const callData = msg.message.call;
      const duration = callData.duration || 0;
      const durationText = new Date(duration * 1000)
        .toISOString()
        .slice(11, 19);

      if (duration > 0) {
        const callType = `Panggilan ${
          callData.isVideo ? "Video" : "Suara"
        } Terhubung dan Berakhir`;
        await logCall(callType, contactId, sock, durationText);
        console.log(
          `[PANGGILAN SELESAI] Panggilan dengan ${contactId} berakhir. Durasi: ${durationText}.`
        );
      } else {
        const callType = `Panggilan ${
          callData.isVideo ? "Video" : "Suara"
        } Berakhir`;
        await logCall(callType, contactId, sock, "00:00:00");
        console.log(
          `[PANGGILAN TAK TERSAMBUNG] Panggilan dengan ${contactId} berakhir tanpa tersambung.`
        );
      }
      return;
    }

    if (msg.key.remoteJid !== "status@broadcast" && !msg.messageStubType) {
      await logMessage(msg, sock);
    }

    if (msg.messageStubType) {
      const contactId = msg.key.remoteJid;
      const isOutgoing = msg.key.fromMe; // Menentukan apakah pesan itu dari bot

      // Hanya proses pesan dari bot
      if (isOutgoing) {
        let callType = "";
        let status = "";

        switch (msg.messageStubType) {
          case WAMessageStubType.CALL_MISSED_VOICE:
            callType = "Panggilan Suara";
            status = "Tak Terjawab";
            break;
          case WAMessageStubType.CALL_MISSED_VIDEO:
            callType = "Panggilan Video";
            status = "Tak Terjawab";
            break;
          case WAMessageStubType.CALL_ENDED:
            // Ini bisa jadi panggilan masuk atau keluar yang berakhir
            // Pengecekan lebih lanjut diperlukan, tetapi ini bisa menjadi titik awal.
            // Logika yang sudah ada di msg.message?.call seharusnya sudah menangani ini.
            break;
          // Anda bisa menambahkan case lain jika menemukan stub type yang relevan
        }

        if (callType && status) {
          const logType = `${callType} Keluar (${status})`;
          await logCall(logType, contactId, sock);
          console.log(
            `[PANGGILAN KELUAR] Bot melakukan ${callType} ke ${contactId} dan ${status}.`
          );
        }
      }
    }
  });

  sock.ev.on("call", async (callEvents) => {
    const call = callEvents[0];
    if (!call) return;

    const botNumber = sock.user.id;
    const isOutgoingCall = call.from === botNumber;
    const contactId = isOutgoingCall ? call.to : call.from;
    const callId = call.id;

    switch (call.status) {
      case "offer":
        callTimestamps.set(callId, {
          start: new Date(),
          type: call.isVideo ? "Video" : "Suara",
          isOutgoing: isOutgoingCall,
          contactId: contactId,
        });
        await logCall(
          `Panggilan ${call.isVideo ? "Video" : "Suara"} ${
            isOutgoingCall ? "Keluar" : "Masuk"
          } (Berdering)`,
          contactId,
          sock
        );
        break;

      case "accept":
        const ongoingCall = callTimestamps.get(callId);
        if (ongoingCall) {
          ongoingCall.accepted = new Date();
          callTimestamps.set(callId, ongoingCall);
          await logCall(
            `Panggilan ${ongoingCall.type} ${
              isOutgoingCall ? "Keluar" : "Masuk"
            } Diterima`,
            contactId,
            sock
          );
        }
        break;

      case "reject":
      case "timeout":
        const rejectedCall = callTimestamps.get(callId);
        if (rejectedCall) {
          await logCall(
            `Panggilan ${rejectedCall.type} ${
              isOutgoingCall ? "Keluar" : "Masuk"
            } ${call.status === "reject" ? "Ditolak" : "Tak Terjawab"}`,
            contactId,
            sock
          );
          callTimestamps.delete(callId);
        }
        break;
    }
  });
}

// Restart Terjadwal
// schedule.scheduleJob("0 2 * * *", () => {
schedule.scheduleJob("5 14 * * *", () => {
  console.log("RESTART TERJADWAL: Memulai ulang aplikasi...");
  process.exit(0);
});

// Jadwal untuk memperbarui daftar nomor yang diblokir (diperbaiki)
// schedule.scheduleJob("0 3 * * *", () => {
schedule.scheduleJob("0 14 * * *", () => {
  console.log("[INFO] Memperbarui daftar nomor yang diblokir...");
  // Periksa status koneksi dengan benar menggunakan readyState
  if (sock && sock.ws.readyState === sock.ws.OPEN) {
    // Panggil fungsi tanpa argumen 'sock' karena 'sock' sudah global
    saveBlockedContactsToFile();
  } else {
    console.log(
      "[GAGAL] Bot tidak terhubung. Gagal memperbarui daftar blokir."
    );
  }
});

startSock();

// Express
app.get("/", (req, res) =>
  res.send("Bot pencatat WhatsApp (Baileys) sedang berjalan!")
);
app.listen(port, () => console.log(`Server berjalan di port ${port}`));
