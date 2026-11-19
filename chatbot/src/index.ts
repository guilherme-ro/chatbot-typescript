/**
 * @fileoverview Ponto de entrada da aplicação do Chatbot.
 *
 * Configura e inicializa o servidor HTTP com Express, instancia o CloudAdapter do Microsoft
 * Bot Framework SDK v4, gerencia o estado da conversação em memória via MemoryStorage
 * e expõe a rota REST para recepção de atividades e mensagens do bot.
 *
 * @remarks
 * **Escolha do Express em substituição ao Restify**:
 * Os templates tradicionais do Bot Framework Yeoman utilizavam Restify por padrão.
 * No entanto, para compatibilidade com o Node.js v24 (e versões LTS recentes), o framework
 * web foi migrado para o Express. O Restify apresenta inconsistências em runtimes modernos
 * do Node.js decorrentes de APIs internas de streams e HTTP descontinuadas, enquanto o Express
 * oferece suporte estável, ampla manutenção, parsing nativo via `express.json()` e interoperabilidade
 * completa com o pipeline de processamento assíncrono do `CloudAdapter`.
 */

import * as path from 'path';
import { config } from 'dotenv';
import express, { Request, Response } from 'express';
import {
    CloudAdapter,
    ConfigurationBotFrameworkAuthentication,
    MemoryStorage,
    ConversationState,
    TurnContext
} from 'botbuilder';
import { EchoBot } from './bot';

// Carrega as variáveis de ambiente a partir do arquivo .env localizado na raiz do projeto
const ENV_FILE = path.join(__dirname, '..', '.env');
config({ path: ENV_FILE });

/**
 * Instância da aplicação Express que atua como servidor HTTP do bot.
 *
 * Substitui o Restify para garantir compatibilidade plena com o Node.js v24+,
 * fornecendo melhor desempenho, estabilidade de middleware e facilidade de integração.
 */
const app = express();

// Habilita o middleware para interpretação automática de payloads em formato JSON
app.use(express.json());

// Define a porta do servidor obtida a partir das variáveis de ambiente (padrão: 3978)
const port = process.env.port || process.env.PORT || 3978;
app.listen(port, () => {
    console.log(`\nServidor Express rodando em http://localhost:${port}`);
});

/**
 * Configuração de autenticação do Bot Framework.
 *
 * Lê as variáveis de ambiente (como `MicrosoftAppId`, `MicrosoftAppPassword`, `MicrosoftAppTenantId`)
 * para autenticar chamadas provenientes do Azure Bot Service ou canais em nuvem.
 * Em desenvolvimento local com o Bot Framework Emulator, as credenciais podem permanecer vazias.
 */
const botFrameworkAuthentication = new ConfigurationBotFrameworkAuthentication(process.env as any);

/**
 * Adaptador de comunicação principal do Bot Framework SDK v4 (`CloudAdapter`).
 *
 * O `CloudAdapter` é o componente central responsável por:
 * 1. Autenticar as requisições HTTP recebidas nos webhooks.
 * 2. Converter os payloads HTTP em instâncias de `Activity` e empacotá-las em um `TurnContext`.
 * 3. Encaminhar as mensagens para a lógica do bot (`EchoBot`).
 * 4. Rotejar respostas e atividades emitidas pelo bot de volta ao canal do usuário.
 */
const adapter = new CloudAdapter(botFrameworkAuthentication);

/**
 * Manipulador global de erros não tratados durante a execução de um turno do bot.
 *
 * Captura qualquer exceção não tratada ocorrida no pipeline do `CloudAdapter` ou na lógica do bot,
 * registrando o erro no console e emitindo uma mensagem amigável para o usuário no canal,
 * evitando que a sessão trave silenciosamente.
 *
 * @param context - O contexto do turno no qual ocorreu a falha.
 * @param error - A instância do erro que foi capturada.
 */
adapter.onTurnError = async (context: TurnContext, error: Error): Promise<void> => {
    console.error(`\n [onTurnError] erro não tratado: ${error}`);
    await context.sendActivity('O bot encontrou um erro interno.');
};

/**
 * Provedor de armazenamento volátil em memória (`MemoryStorage`).
 *
 * Implementa a interface de persistência de estado do Bot Framework mantendo os dados
 * na memória RAM do processo Node.js.
 *
 * @remarks
 * Ideal para testes locais e ambientes de desenvolvimento/PoC por não exigir bancos de dados externos.
 * Para ambientes de produção com múltiplas instâncias ou escalabilidade horizontal,
 * recomenda-se substituir por adaptadores de persistência durável, como `CosmosDbPartitionedStorage`
 * ou `BlobsStorage`.
 */
const memoryStorage = new MemoryStorage();

/**
 * Gerenciador de estado de conversação (`ConversationState`).
 *
 * Vincula-se ao `MemoryStorage` e gerencia propriedades que pertencem ao escopo da conversa
 * (identificada por canal e `conversation.id`), como o histórico de interações com o modelo Phi-4.
 */
const conversationState = new ConversationState(memoryStorage);

/**
 * Instância principal da classe do bot (`EchoBot`), injetando o gerenciador de estado.
 */
const myBot = new EchoBot(conversationState);

/**
 * Endpoint HTTP REST `POST /api/messages` que recebe todas as atividades direcionadas ao bot.
 *
 * As requisições enviadas por canais (Teams, WebChat ou Bot Framework Emulator) chegam a esta rota.
 * O `adapter.process` autentica a requisição, cria o `TurnContext` correspondente e delega a execução
 * para o método `myBot.run(context)`.
 *
 * @param req - Objeto de requisição do Express contendo o payload da atividade.
 * @param res - Objeto de resposta do Express para confirmação HTTP da entrega da mensagem.
 */
app.post('/api/messages', async (req: Request, res: Response): Promise<void> => {
    await adapter.process(req, res, (context) => myBot.run(context));
});
