import bodyParser from 'body-parser';
import { Router } from 'express';
import { Chalk } from 'chalk';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { Readable } from 'stream';
import fs from 'fs';
import path from 'path';
import xmlEscape from 'xml-escape';

interface PluginInfo {
    id: string;
    name: string;
    description: string;
}

interface Plugin {
    init: (router: Router) => Promise<void>;
    exit: () => Promise<void>;
    info: PluginInfo;
}

interface EmotionProsody {
    label: string;
    rate: number;
    pitch: number;
    volume: number;
}

interface ProsodyOptions {
    rate: string;
    pitch: string;
    volume: string;
}

interface VoiceProfile {
    rate: number;
    pitch: number;
}

interface TextSignals {
    exclaims: number;
    ellipsis: number;
    questions: number;
    caps: number;
    stutter: boolean;
    laughter: boolean;
}

const chalk = new Chalk();
const MODULE_NAME = '[SillyTavern-EdgeTTS-Plugin]';

const NEUTRAL: EmotionProsody = { label: 'neutral', rate: 1, pitch: 0, volume: 0 };
const EXCITED: EmotionProsody = { label: 'excited', rate: 1.16, pitch: 4, volume: 11 };
const PENSIVE: EmotionProsody = { label: 'pensive', rate: 0.9, pitch: -4, volume: -10 };
const CURIOUS: EmotionProsody = { label: 'curious', rate: 1.05, pitch: 3, volume: 0 };
const EMPHATIC: EmotionProsody = { label: 'emphatic', rate: 1.08, pitch: 2, volume: 6 };

// Base pace and pitch per voice: voice lines should not all start from the same tempo.
const DEFAULT_VOICE_PROFILE: VoiceProfile = { rate: 1, pitch: 0 };
const BUILTIN_VOICE_PROFILES: Record<string, VoiceProfile> = {
    'es-MX-JorgeNeural': { rate: 1.12, pitch: -3 },
};

function getVoiceProfile(voice: string): VoiceProfile {
    let profiles = BUILTIN_VOICE_PROFILES;
    try {
        const file = path.join(process.cwd(), 'plugins', 'edge-tts', 'voice-profiles.json');
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (parsed && typeof parsed === 'object') {
            profiles = { ...BUILTIN_VOICE_PROFILES, ...parsed };
        }
    } catch {
        // config file missing or invalid: keep builtin profiles
    }
    return { ...DEFAULT_VOICE_PROFILE, ...(profiles[voice] || {}) };
}

// Recent emotion memory: lets dialogue inherit the emotion described by the previous action segment.
const EMOTION_MEMORY_TTL_MS = 20000;
let lastEmotion: EmotionProsody = NEUTRAL;
let lastIntensity = 0;
let lastVoice = '';
let lastEmotionTime = 0;

const RULES: { words: string[]; emotion: EmotionProsody }[] = [
    { emotion: { label: 'happy', rate: 1.13, pitch: 5, volume: 7 }, words: ['feliz', 'alegr', 'contenta', 'sonri', 'risa', 'jaja', 'jeje', 'jiji', 'jsjs', 'emocionad', 'encantad', 'maravillos', 'genial', 'increible', 'te quiero', 'te amo', 'ador', 'gracias', 'por fin', 'buenisim', 'hermos', 'me encanta', 'que bien', 'divertid', 'precioso', 'linda', 'cariño', 'abraz'] },
    { emotion: { label: 'angry', rate: 1.13, pitch: 3, volume: 15 }, words: ['furios', 'enojad', 'rabia', 'grit', 'maldit', 'odio', 'irritad', 'estupid', 'imbecil', 'idiota', 'tonto', 'basta', 'callate', 'golpe', 'romper', 'mierda', 'carajo', 'puta', 'frustrad', 'harto', 'hart', 'bofetada'] },
    { emotion: { label: 'sad', rate: 0.84, pitch: -6, volume: -13 }, words: ['trist', 'lagrim', 'llor', 'solloz', 'suspiro', 'deprimid', 'dolor', 'extran', 'soledad', 'adios', 'perdid', 'vacio', 'duele', 'lo siento', 'perdon', 'sin ti', 'ultima vez', 'olvidar'] },
    { emotion: { label: 'fear', rate: 1.12, pitch: 6, volume: -6 }, words: ['miedo', 'asust', 'nervi', 'temblor', 'tembl', 'panic', 'ansied', 'preocup', 'insegur', 'no puedo', 'ayuda', 'peligro', 'cuidado', 'socorro', 'horror', 'pesadilla', 'corre', 'agitad', 'hiperventil', 'por favor', 'no me hagas'] },
    { emotion: { label: 'shy', rate: 0.92, pitch: 3, volume: -19 }, words: ['rubor', 'sonroj', 'avergonz', 'timid', 'apenad', 'verguenza', 'no mires', 'que pena', 'me da pena', 'no te enfades', 'juguetea'] },
    { emotion: { label: 'seductive', rate: 0.82, pitch: -5, volume: -12 }, words: ['seduc', 'provoc', 'jadea', 'gemid', 'morb', 'caliente', 'deseo', 'me deseas', 'besa', 'beso', 'despacio', 'cuerpo', 'piel', 'mirame', 'tocame', 'mojada', 'cama', 'dentro de mi', 'duro'] },
    { emotion: { label: 'whisper', rate: 0.88, pitch: -3, volume: -27 }, words: ['susurr', 'en voz baja', 'al oido', 'shhh', 'apenas audible'] },
    { emotion: { label: 'playful', rate: 1.07, pitch: 4, volume: 6 }, words: ['coquete', 'malicia', 'picar', 'juguet', 'broma', 'teasing', 'travies', 'guan'] },
    { emotion: { label: 'bored', rate: 0.94, pitch: -3, volume: -9 }, words: ['da igual', 'me da igual', 'no me importa', 'aburrid', 'en serio', 'sarcasmo', 'levanta una ceja', 'que mas da'] },
    { emotion: { label: 'tired', rate: 0.88, pitch: -4, volume: -16 }, words: ['cansad', 'agotad', 'sueno', 'dormid', 'debil', 'exhaust', 'bostezo', 'no puedo mas', 'rendid', 'no dormi'] },
];

function normalize(text: string): string {
    return text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function countOccurrences(text: string, needle: string): number {
    return text.split(needle).length - 1;
}

function getSignals(text: string, plain: string): TextSignals {
    return {
        exclaims: countOccurrences(text, '!'),
        ellipsis: countOccurrences(text, '...') + countOccurrences(text, '\u2026'),
        questions: countOccurrences(text, '?'),
        caps: (text.match(/\b[A-Z\u00c1\u00c9\u00cd\u00d3\u00da\u00d1]{3,}\b/g) || []).length,
        stutter: /\b(\w+)-\1/.test(plain),
        laughter: /jaja|jeje|jiji|jsjs|lol/.test(plain),
    };
}

function analyzeEmotion(text: string): { emotion: EmotionProsody; intensity: number; signals: TextSignals; explicit: boolean } {
    const plain = normalize(text);
    const signals = getSignals(text, plain);

    let best: EmotionProsody = NEUTRAL;
    let bestScore = 0;

    for (const rule of RULES) {
        let hits = 0;
        for (const word of rule.words) {
            if (plain.includes(word)) {
                hits++;
            }
        }
        const score = hits > 0 ? 2 * hits + Math.min(4, hits) : 0;
        if (score > bestScore) {
            bestScore = score;
            best = rule.emotion;
        }
    }

    let explicit = bestScore > 0;

    if (bestScore === 0) {
        if (signals.laughter || signals.exclaims >= 2 || signals.caps >= 1) {
            best = EXCITED;
            explicit = true;
        } else if (signals.ellipsis >= 2) {
            best = PENSIVE;
            explicit = true;
        } else if (signals.questions >= 2) {
            best = CURIOUS;
            explicit = true;
        } else if (signals.exclaims === 1) {
            best = EMPHATIC;
            explicit = true;
        }
    }

    const intensity = Math.min(1, 0.5 + bestScore / 8);

    return { emotion: best, intensity, signals, explicit };
}

function buildProsodyOptions(baseRate: number, profile: VoiceProfile, emotion: EmotionProsody, intensity: number, signals: TextSignals): ProsodyOptions {
    const jitter = (Math.random() - 0.5) * 2;

    let rate = (1 + baseRate / 100) * profile.rate * (1 + (emotion.rate - 1) * intensity) + jitter * 0.03;
    let pitch = profile.pitch + emotion.pitch * intensity + jitter * 2.5;
    let volume = emotion.volume * intensity + jitter * 4;

    if (signals.exclaims > 0) {
        rate += 0.015;
        pitch += 1.5;
        volume += 3;
    }
    if (signals.questions > 0) {
        rate += 0.01;
        pitch += 1;
    }
    if (signals.ellipsis > 0) {
        rate -= 0.03;
        volume -= 3;
    }
    if (signals.caps > 0) {
        rate += 0.02;
        volume += 3;
    }
    if (signals.stutter) {
        rate -= 0.02;
        pitch += 0.5;
    }

    rate = Math.min(1.65, Math.max(0.55, rate));
    pitch = Math.min(18, Math.max(-18, Math.round(pitch)));
    volume = Math.min(22, Math.max(-32, Math.round(volume)));

    const ratePercent = `${rate >= 1 ? '+' : ''}${Math.round((rate - 1) * 100)}%`;
    const pitchPercent = `${pitch >= 0 ? '+' : ''}${pitch}%`;
    const volumePercent = `${volume >= 0 ? '+' : ''}${volume}%`;

    return { rate: ratePercent, pitch: pitchPercent, volume: volumePercent };
}

async function getVoices() {
    const tts = new MsEdgeTTS();
    const voices = await tts.getVoices();
    return voices;
}

async function getVoiceStream(text: string, voice: string, prosody: ProsodyOptions): Promise<Readable> {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(voice, OUTPUT_FORMAT.WEBM_24KHZ_16BIT_MONO_OPUS);
    const { audioStream } = tts.toStream(xmlEscape(text), prosody);
    return audioStream;
}

/**
 * Initialize the plugin.
 * @param router Express Router
 */
export async function init(router: Router): Promise<void> {
    const jsonParser = bodyParser.json();
    // Used to check if the server plugin is running
    router.post('/probe', (_req, res) => {
        return res.sendStatus(204);
    });
    router.get('/list', async (_req, res) => {
        try {
            const voices = await getVoices();
            return res.json(voices);
        } catch (error) {
            console.error(chalk.red(MODULE_NAME), 'Request failed', error);
            return res.status(500).send('Internal Server Error');
        }
    });
    router.post('/generate', jsonParser, async (req, res) => {
        try {
            const { text, voice, rate } = req.body;
            if (!text || !voice) {
                return res.status(400).send('Bad Request');
            }

            const analysis = analyzeEmotion(text);
            let { emotion, intensity, signals } = analysis;
            const now = Date.now();

            if (analysis.explicit) {
                lastEmotion = emotion;
                lastIntensity = intensity;
                lastVoice = voice;
                lastEmotionTime = now;
            } else if (now - lastEmotionTime < EMOTION_MEMORY_TTL_MS && lastEmotion.label !== 'neutral') {
                // No emotion in this segment: inherit the recent one (action -> dialogue context).
                emotion = lastEmotion;
                intensity = lastVoice === voice ? lastIntensity * 0.6 : lastIntensity * 0.85;
                lastEmotionTime = now;
            }

            const profile = getVoiceProfile(voice);
            const prosody = buildProsodyOptions(Number(rate) || 0, profile, emotion, intensity, signals);
            const inherited = !analysis.explicit && emotion.label !== 'neutral' && emotion === lastEmotion ? ' (heredada)' : '';
            console.log(chalk.gray(MODULE_NAME), `emotion=${emotion.label}${inherited} intensity=${intensity.toFixed(2)} rate=${prosody.rate} pitch=${prosody.pitch} volume=${prosody.volume}`);

            const stream = await getVoiceStream(text, voice, prosody);
            res.setHeader('Content-Type', 'audio/webm');
            return stream.pipe(res);
        } catch (error) {
            console.error(chalk.red(MODULE_NAME), 'Request failed', error);
            return res.status(500).send('Internal Server Error');
        }
    });

    console.log(chalk.green(MODULE_NAME), 'Plugin loaded!');
}

export async function exit(): Promise<void> {
    console.log(chalk.yellow(MODULE_NAME), 'Plugin exited');
}

export const info: PluginInfo = {
    id: 'edge-tts',
    name: 'EdgeTTS Provider',
    description: 'EdgeTTS voice provider for SillyTavern TTS extension.',
};

const plugin: Plugin = {
    init,
    exit,
    info,
};

export default plugin;
