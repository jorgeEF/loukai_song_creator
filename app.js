import express from 'express';
import fileUpload from 'express-fileupload';
import { spawn } from 'child_process';
import { Atoms } from 'm4a-stems';
import path from 'path';
import fs, { existsSync, mkdirSync, unlinkSync, rmSync, readdirSync } from 'fs';
import open, { apps } from 'open';

const app = express();
const PORT = 3000;

app.use(express.static('public'));
app.use(express.json());
app.use(fileUpload({ useTempFiles: true, tempFileDir: './tmp/' }));

['./input', './output', './separated', './tmp'].forEach(dir => {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
});

// --- HELPER: Parsear texto LRC manual a la estructura requerida por KaraAtom ---
function parseLrcToLines(lrcText) {
    const defaultLine = [{ 
        start: 0, 
        end: 10, 
        text: "JF Soluciones karaoke ready", 
        words: { timings: [[0, 10]] } 
    }];

    if (!lrcText || !lrcText.trim()) return defaultLine;

    const rawLines = lrcText.split('\n').filter(line => line.includes(']'));
    const lines = rawLines.map((line, index, array) => {
        const match = line.match(/\[(\d+):(\d+\.\d+)\]\s*(.*)/);
        if (!match) return null;

        const start = parseInt(match[1]) * 60 + parseFloat(match[2]);
        const text = match[3].trim() || "...";

        let end = start + 3; 
        if (array[index + 1]) {
            const nextMatch = array[index + 1].match(/\[(\d+):(\d+\.\d+)\]/);
            if (nextMatch) end = parseInt(nextMatch[1]) * 60 + parseFloat(nextMatch[2]);
        }
        return { start, end, text, words: { timings: [[0, end - start]] } };
    }).filter(l => l !== null);

    return lines.length > 0 ? lines : defaultLine;
}

// --- METADATOS CON FFPROBE ---
function getMetadata(file) {
    return new Promise((resolve, reject) => {
        const ffprobe = spawn('ffprobe', [
            '-v', 'quiet',
            '-print_format', 'json',
            '-show_format',
            file
        ]);

        let output = '';
        ffprobe.stdout.on('data', (data) => output += data);
        ffprobe.on('close', (code) => {
            if (code === 0) {
                const format = JSON.parse(output).format || {};
                const tags = format.tags || {};
                
                const rawTitle = tags.title || path.parse(file).name;
                const cleanTitle = rawTitle.replace(/^\d+(\.\d+)?[.-]\s*/, "").trim();

                resolve({
                    title: cleanTitle,
                    artist: tags.artist || 'Artista Desconocido',
                    album: tags.album || '',
                    duration: Math.round(parseFloat(format.duration || 0)),
                    year: tags.date || tags.year || '2026',
                    genre: tags.genre || ''
                });
            } else {
                reject("Error al leer metadatos con FFprobe");
            }
        });
    });
}

// --- BÚSQUEDA PREVIA DE LETRAS EN LRCLIB ---
async function fetchLyricsPreview(meta) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const url = `https://lrclib.net/api/get?artist_name=${encodeURIComponent(meta.artist)}&track_name=${encodeURIComponent(meta.title)}&album_name=${encodeURIComponent(meta.album)}&duration=${meta.duration}`;

    try {
        console.log(`🌐 Pre-buscando letras en LRCLIB: ${meta.artist} - ${meta.title}`);
        const response = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': 'JF-Soluciones-Karaoke-Gen (https://jfsoluciones.com.ar)' }
        });

        clearTimeout(timeout);
        if (!response.ok) return { found: false, rawLrc: "" };

        const data = await response.json();
        if (!data.syncedLyrics) return { found: false, rawLrc: "" };

        return { found: true, rawLrc: data.syncedLyrics };
    } catch {
        clearTimeout(timeout);
        return { found: false, rawLrc: "" };
    }
}

// --- CONVERSIÓN A M4A ---
function convertToM4a(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        const ffmpeg = spawn('ffmpeg', [
            '-i', inputPath,
            '-c:a', 'aac',
            '-b:a', '128k',
            '-y',
            outputPath
        ]);

        let errorMsg = '';
        ffmpeg.stderr.on('data', d => errorMsg += d.toString());

        ffmpeg.on('close', (code) => {
            if (code === 0) resolve();
            else reject(`Error FFmpeg al convertir ${inputPath}: ${errorMsg}`);
        });
    });
}

// --- EJECUCIÓN DE DEMUCS CON EMISIÓN DE LOGS ---
function runDemucs(inputFile, onLog) {
    return new Promise((resolve, reject) => {
        onLog("🎛️ Iniciando separación de stems con Demucs...");
        
        const demucs = spawn('cmd.exe', [
            '/c', 'demucs',
            '--filename', '{stem}.mp3',
            '--mp3',
            '--mp3-bitrate', '192',
            '-o', './separated',
            inputFile
        ]);

        let errorMsg = '';
        demucs.stdout.on('data', data => {
            const str = data.toString().trim();
            if (str) onLog(`[Demucs]: ${str}`);
        });
        
        demucs.stderr.on('data', data => {
            const str = data.toString().trim();
            if (str) onLog(`[Demucs log]: ${str}`);
            errorMsg += str;
        });

        demucs.on('close', (code) => {
            if (code === 0) resolve();
            else reject(`Demucs falló con código ${code}. Detalle: ${errorMsg}`);
        });
    });
}

// --- FFMPEG ---
function runFFmpeg(config) {
    return new Promise((resolve, reject) => {
        const args = [];
        config.inputs.forEach(file => args.push('-i', file));

        args.push(
            '-map', '0:a', '-map', '1:a', '-map', '2:a', '-map', '3:a', '-map', '4:a',
            '-c', 'copy',
            '-map_metadata', '-1',
            '-metadata', `title=${config.metadata.title}`,
            '-metadata', `artist=${config.metadata.artist}`,
            '-metadata', `album=${config.metadata.album}`,
            '-metadata', `date=${config.metadata.year}`,
            '-metadata', `genre=${config.metadata.genre}`,
            '-metadata:s:a:0', 'title=master',
            '-metadata:s:a:1', 'title=drums',
            '-metadata:s:a:2', 'title=bass',
            '-metadata:s:a:3', 'title=other',
            '-metadata:s:a:4', 'title=vocals',
            '-disposition:a:0', 'default',
            '-movflags', '+faststart',
            '-f', 'mp4', 
            '-brand', 'M4A ',
            '-brand', 'mp42',
            '-y', 
            config.output
        );

        const ffmpeg = spawn('ffmpeg', args);
        let errorMsg = '';
        ffmpeg.stderr.on('data', (d) => errorMsg += d.toString());

        ffmpeg.on('close', (code) => {
            if (code === 0) resolve();
            else reject(`FFmpeg falló con código ${code}: ${errorMsg}`);
        });
    });
}

// ================= RUTA 1: SUBIR Y MOSTRAR PREVIEW + LETRAS =================
app.post('/upload-preview', async (req, res) => {
    if (!req.files || !req.files.audio) {
        return res.status(400).json({ error: 'No se subió ningún archivo' });
    }

    const audioFile = req.files.audio;
    const tempFileName = `temp_${Date.now()}${path.extname(audioFile.name)}`;
    const tempPath = path.join('./input', tempFileName);

    try {
        await audioFile.mv(tempPath);
        const meta = await getMetadata(tempPath);
        const lyricsData = await fetchLyricsPreview(meta);

        res.json({
            success: true,
            tempFileName: tempFileName,
            originalName: audioFile.name,
            metadata: meta,
            lyrics: lyricsData
        });
    } catch (error) {
        if (existsSync(tempPath)) unlinkSync(tempPath);
        res.status(500).json({ error: error.toString() });
    }
});

// ================= RUTA 2: SEPARACIÓN Y COMPILACIÓN FINAL (SSE LOGS) =================
app.post('/process-stem', async (req, res) => {
    // Configuramos SSE para enviar eventos en tiempo real
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const sendLog = (msg) => {
        res.write(`data: ${JSON.stringify({ type: 'log', message: msg })}\n\n`);
    };

    const { tempFileName, title, artist, album, year, genre, duration, rawLrc } = req.body;
    const inputMasterPath = path.join('./input', tempFileName);

    if (!existsSync(inputMasterPath)) {
        res.write(`data: ${JSON.stringify({ type: 'error', error: 'El archivo temporal expiró o no existe.' })}\n\n`);
        return res.end();
    }

    try {
        const meta = { title, artist, album, year, genre, duration: parseInt(duration) };
        
        if (existsSync('./separated')) {
            rmSync('./separated', { recursive: true, force: true });
            mkdirSync('./separated', { recursive: true });
        }       

        // 1. Demucs
        await runDemucs(inputMasterPath, sendLog);

        function findStemFolder(dir) {
            if (!existsSync(dir)) return null;
            const entries = readdirSync(dir, { withFileTypes: true });
            const hasStems = entries.some(e => e.isFile() && e.name.startsWith('drums'));
            if (hasStems) return dir;

            for (const entry of entries) {
                if (entry.isDirectory()) {
                    const found = findStemFolder(path.join(dir, entry.name));
                    if (found) return found;
                }
            }
            return null;
        }

        const stemDir = findStemFolder('./separated');
        if (!stemDir) throw new Error("No se encontraron las pistas generadas por Demucs.");

        sendLog("🔄 Codificando pistas individuales a M4A (128kbps)...");
        const stemNames = ['drums', 'bass', 'other', 'vocals'];
        const m4aFiles = {};
        const filesInDir = readdirSync(stemDir);

        for (const stem of stemNames) {
            const foundFile = filesInDir.find(f => f.startsWith(stem));
            if (!foundFile) throw new Error(`Falta el archivo para la pista ${stem}`);

            const sourcePath = path.join(stemDir, foundFile);
            const m4aPath = path.join(stemDir, `${stem}_converted.m4a`);

            await convertToM4a(sourcePath, m4aPath);
            m4aFiles[stem] = m4aPath;
        }

        const inputs = [
            inputMasterPath,
            m4aFiles['drums'],
            m4aFiles['bass'],
            m4aFiles['other'],
            m4aFiles['vocals']
        ];

        // 2. Parsear el texto LRC que vino desde el cliente
        sendLog("📝 Sincronizando letra en formato karaoke...");
        const lyricsLines = parseLrcToLines(rawLrc);

        const safeName = `${artist} - ${title}`.replace(/[<>:"/\\|?*]/g, "").trim();
        const outputPath = path.join('./output', `${safeName}.stem.mp4`);

        const config = {
            inputs,
            output: outputPath,
            metadata: meta,
            kara: {
                timing: { offset_sec: 0, encoder_delay_samples: 0 },
                lines: lyricsLines
            }
        };

        sendLog("🚀 Uniendo pistas y empaquetando MP4...");
        await runFFmpeg(config);

        sendLog("🛠️ Inyectando átomos NI Stem y metadata de karaoke...");
        await Atoms.writeKaraAtom(config.output, config.kara);
        await Atoms.addNiStemsMetadata(config.output, ['drums', 'bass', 'other', 'vocals']);

        rmSync(stemDir, { recursive: true, force: true });
        unlinkSync(inputMasterPath);

        sendLog("✅ ¡Proceso finalizado con éxito!");
        res.write(`data: ${JSON.stringify({ 
            type: 'done', 
            file: `${safeName}.stem.mp4`, 
            downloadUrl: `/download/${encodeURIComponent(`${safeName}.stem.mp4`)}` 
        })}\n\n`);
        res.end();

    } catch (error) {
        if (existsSync(inputMasterPath)) unlinkSync(inputMasterPath);
        res.write(`data: ${JSON.stringify({ type: 'error', error: error.toString() })}\n\n`);
        res.end();
    }
});

app.get('/download/:filename', (req, res) => {
    const file = path.join('./output', req.params.filename);
    if (existsSync(file)) res.download(file);
    else res.status(404).send('Archivo no encontrado');
});

app.post('/shutdown', (req, res) => {
    res.json({ success: true, message: 'Servidor deteniéndose...' });
    setTimeout(() => process.exit(0), 1000);
});

app.listen(PORT, async () => {
    console.log(`🌐 Servidor corriendo en http://localhost:${PORT}`);
    try {
        await open(`http://127.0.0.1:${PORT}`, { app: { name: apps.browser } });
    } catch (err) {
        console.error('Error abriendo navegador:', err);
    }
});