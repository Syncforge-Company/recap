import { Config } from '../config';
import { TranscriptionService, Transcriber } from './transcription-service';
import { GroqTranscriptionService } from './groq-transcription-service';

/** The transcription provider selected by TRANSCRIPTION_PROVIDER. */
export function createTranscriber(): Transcriber {
  if (Config.TRANSCRIPTION_PROVIDER === 'groq') return new GroqTranscriptionService(Config.GROQ_API_KEY);
  return new TranscriptionService(Config.DEEPGRAM_API_KEY);
}
