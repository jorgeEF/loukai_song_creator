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
                
                // Limpieza preventiva de título (quita '01. ', '02 - ', etc.)
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

// --- BÚSQUEDA DE LETRAS ---
async function fetchLyrics(meta) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const url = `https://lrclib.net/api/get?artist_name=${encodeURIComponent(meta.artist)}&track_name=${encodeURIComponent(meta.title)}&album_name=${encodeURIComponent(meta.album)}&duration=${meta.duration}`;

    const safeLine = [{ 
        start: 0, 
        end: 10, 
        text: "JF Soluciones karaoke ready", 
        words: { timings: [[0, 10]] } 
    }];

    try {
        console.log(`🌐 Buscando letras en LRCLIB: ${meta.artist} - ${meta.title}`);
        const response = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': 'JF-Soluciones-Karaoke-Gen (https://jfsoluciones.com.ar)' }
        });

        clearTimeout(timeout);
        if (!response.ok) return safeLine;

        const data = await response.json();
        if (!data.syncedLyrics) return safeLine;

        const lines = data.syncedLyrics.split('\n')
            .filter(line => line.includes(']'))
            .map((line, index, array) => {
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

        return lines.length > 0 ? lines : safeLine;

    } catch {
        clearTimeout(timeout);
        return safeLine;
    }
}

// --- CONVERSIÓN A M4A (128k) ---
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

// --- EJECUCIÓN DE DEMUCS DIRECTO A MP3 (192k) ---
function runDemucs(inputFile) {
    return new Promise((resolve, reject) => {
        console.log("🎛️ Ejecutando Demucs...");
        
        const demucs = spawn('cmd.exe', [
            '/c', 'demucs',
            '--filename', '{stem}.mp3',
            '--mp3',
            '--mp3-bitrate', '192',
            '-o', './separated',
            inputFile
        ]);

        let errorMsg = '';
        demucs.stdout.on('data', data => console.log(`[Demucs]: ${data.toString().trim()}`));
        demucs.stderr.on('data', data => {
            const str = data.toString();
            console.log(`[Demucs log]: ${str.trim()}`);
            errorMsg += str;
        });

        demucs.on('close', (code) => {
            if (code === 0) resolve();
            else reject(`Demucs falló con código ${code}. Detalle: ${errorMsg}`);
        });
    });
}

// --- FFMPEG (Ensamblado final de pistas) ---
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

// ================= RUTA 1: SUBIR Y LEER METADATOS =================
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

        res.json({
            success: true,
            tempFileName: tempFileName,
            originalName: audioFile.name,
            metadata: meta
        });
    } catch (error) {
        if (existsSync(tempPath)) unlinkSync(tempPath);
        res.status(500).json({ error: error.toString() });
    }
});

// ================= RUTA 2: SEPARAR CON DEMUCS Y GENERAR STEM =================
app.post('/process-stem', async (req, res) => {
    const { tempFileName, title, artist, album, year, genre, duration } = req.body;
    const inputMasterPath = path.join('./input', tempFileName);

    if (!existsSync(inputMasterPath)) {
        return res.status(400).json({ error: 'El archivo temporal expiró o no existe.' });
    }

    try {
        const meta = { title, artist, album, year, genre, duration: parseInt(duration) };
		
		// Limpiar procesamientos anteriores antes de ejecutar Demucs
		if (existsSync('./separated')) {
			rmSync('./separated', { recursive: true, force: true });
			mkdirSync('./separated', { recursive: true });
		}
		
		// Limpiar procesamientos anteriores antes de ejecutar Demucs
		if (existsSync('./input')) {
			rmSync('./input', { recursive: true, force: true });
			mkdirSync('./input', { recursive: true });
		}

        // 1. Separar pistas con Demucs
		await runDemucs(inputMasterPath);

		// --- SOLUCIÓN: Búsqueda recursiva del directorio final de stems ---
		function findStemFolder(dir) {
			if (!existsSync(dir)) return null;
			const entries = readdirSync(dir, { withFileTypes: true });

			// Si encontramos alguno de los stems (.mp3 o .wav), este es el directorio correcto
			const hasStems = entries.some(e => e.isFile() && e.name.startsWith('drums'));
			if (hasStems) return dir;

			// Si no, seguimos buscando en subcarpetas
			for (const entry of entries) {
				if (entry.isDirectory()) {
					const found = findStemFolder(path.join(dir, entry.name));
					if (found) return found;
				}
			}
			return null;
		}

		const separatedBaseDir = path.join('./separated');
		const stemDir = findStemFolder(separatedBaseDir);

		if (!stemDir) {
			throw new Error(`Demucs terminó, pero no se encontraron los archivos de audio en ${separatedBaseDir}`);
		}

		console.log(`📂 Carpeta de stems localizada en: ${stemDir}`);

        // 2. Localizar y Convertir dinámicamente los 4 stems a M4A (128k)
        console.log(`🔄 Verificando archivos en ${stemDir} y codificando stems a M4A (128kbps)...`);
        const stemNames = ['drums', 'bass', 'other', 'vocals'];
        const m4aFiles = {};

        const filesInDir = readdirSync(stemDir);

        for (const stem of stemNames) {
            const foundFile = filesInDir.find(f => f.startsWith(stem));

            if (!foundFile) {
                throw new Error(`No se encontró la pista ${stem} en la carpeta ${stemDir}`);
            }

            const sourcePath = path.join(stemDir, foundFile);
            const m4aPath = path.join(stemDir, `${stem}_converted.m4a`);

            await convertToM4a(sourcePath, m4aPath);
            m4aFiles[stem] = m4aPath;
        }

        // 3. Inputs exactos para el paquete de 5 canales
        const inputs = [
            inputMasterPath,     // Canal 0: Master original
            m4aFiles['drums'],   // Canal 1: Drums
            m4aFiles['bass'],    // Canal 2: Bass
            m4aFiles['other'],   // Canal 3: Other
            m4aFiles['vocals']   // Canal 4: Vocals
        ];

        // 4. Buscar letras sincronizadas
        const lyricsLines = await fetchLyrics(meta);

        // 5. Empaquetar el .stem.mp4 con FFmpeg e inyección de átomos
        const safeName = `${artist} - ${title}`.replace(/[<>:"/\\|?*]/g, "").trim();
        const outputPath = path.join('./output', `${safeName}.stem.mp4`);

        const config = {
            inputs: inputs,
            output: outputPath,
            metadata: meta,
            kara: {
                timing: { offset_sec: 0, encoder_delay_samples: 0 },
                lines: lyricsLines
            }
        };

        console.log("🚀 Uniendo pistas con FFmpeg...");
        await runFFmpeg(config);

        console.log("🛠️ Inyectando átomos NI Stem...");
        await Atoms.writeKaraAtom(config.output, config.kara);
        await Atoms.addNiStemsMetadata(config.output, ['drums', 'bass', 'other', 'vocals']);

        // Limpieza de carpeta temporal
        rmSync(stemDir, { recursive: true, force: true });
        unlinkSync(inputMasterPath);

        res.json({
            success: true,
            file: `${safeName}.stem.mp4`,
            downloadUrl: `/download/${encodeURIComponent(`${safeName}.stem.mp4`)}`
        });

    } catch (error) {
        console.error("❌ Error:", error);
        if (existsSync(inputMasterPath)) unlinkSync(inputMasterPath);
        res.status(500).json({ error: error.toString() });
    }
});

app.get('/download/:filename', (req, res) => {
    const file = path.join('./output', req.params.filename);
    if (existsSync(file)) {
        res.download(file);
    } else {
        res.status(404).send('Archivo no encontrado');
    }
});

// app.listen(PORT, () => {
    // console.log(`🌐 Servidor corriendo en http://localhost:${PORT}`);
// });
app.listen(PORT, async () => {
    console.log(`🌐 Servidor corriendo en http://localhost:${PORT}`);
    
    try {
        await open(`http://127.0.0.1:${PORT}`, { app: { name: apps.browser } });
    } catch (err) {
        console.error('Error abriendo navegador:', err);
    }
});

// Ruta para apagar el servidor de forma segura
app.post('/shutdown', (req, res) => {
    res.json({ success: true, message: 'Servidor deteniéndose...' });
    
    console.log('🛑 Cerrando servidor por solicitud del usuario...');
    
    // Le damos 1 segundo al cliente para recibir la respuesta JSON antes de apagar
    setTimeout(() => {
        process.exit(0); // 0 indica salida limpia/exitosa
    }, 1000);
});