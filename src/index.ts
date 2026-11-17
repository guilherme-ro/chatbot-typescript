import * as path from 'path';
import { config } from 'dotenv';
import express from 'express';
import {
    CloudAdapter,
    ConfigurationBotFrameworkAuthentication,
    MemoryStorage,
    ConversationState,
    TurnContext
} from 'botbuilder';
import { EchoBot } from './bot';

const ENV_FILE = path.join(__dirname, '..', '.env');
config({ path: ENV_FILE });

const app = express();
app.use(express.json());

const port = process.env.port || process.env.PORT || 3978;
app.listen(port, () => {
    console.log(`\nServidor Express rodando em http://localhost:${port}`);
});

const botFrameworkAuthentication = new ConfigurationBotFrameworkAuthentication(process.env as any);
const adapter = new CloudAdapter(botFrameworkAuthentication);

adapter.onTurnError = async (context: TurnContext, error: Error) => {
    console.error(`\n [onTurnError] erro não tratado: ${error}`);
    await context.sendActivity('O bot encontrou um erro interno.');
};

const memoryStorage = new MemoryStorage();
const conversationState = new ConversationState(memoryStorage);
const myBot = new EchoBot(conversationState);

app.post('/api/messages', async (req, res) => {
    await adapter.process(req, res, (context) => myBot.run(context));
});
