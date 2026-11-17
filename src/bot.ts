import {
    ActivityHandler,
    MessageFactory,
    ConversationState,
    StatePropertyAccessor,
    TurnContext
} from 'botbuilder';
import OpenAI from 'openai';

interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

const CONVERSATION_HISTORY_PROPERTY = 'conversationHistoryProperty';
const MAX_HISTORY_MESSAGES = 20;

export class EchoBot extends ActivityHandler {
    private client: OpenAI;
    private modelName: string;
    private conversationState: ConversationState;
    private historyAccessor: StatePropertyAccessor<ChatMessage[]>;

    constructor(conversationState: ConversationState) {
        super();

        this.conversationState = conversationState;
        this.historyAccessor = this.conversationState.createProperty<ChatMessage[]>(
            CONVERSATION_HISTORY_PROPERTY
        );

        this.modelName = process.env.AZURE_PHI_MODEL || 'Phi-4-reasoning';

        this.client = new OpenAI({
            baseURL: process.env.AZURE_PHI_ENDPOINT,
            apiKey: process.env.AZURE_PHI_API_KEY,
        });

        this.onMessage(async (context, next) => {
            const textoUsuario = context.activity.text.trim();

            if (textoUsuario.toLowerCase() === '/limpar') {
                await this.historyAccessor.set(context, []);
                await context.sendActivity(MessageFactory.text('Histórico apagado. Como posso ajudar?'));
                await next();
                return;
            }

            try {
                await context.sendActivity({ type: 'typing' });

                const historico = await this.historyAccessor.get(context, []);
                historico.push({ role: 'user', content: textoUsuario });

                const response = await this.client.chat.completions.create({
                    model: this.modelName,
                    messages: [
                        { role: 'system', content: 'Você é um assistente virtual útil e direto. Não faça análises longas; responda de forma imediata, curta e sempre em português.' },
                        ...historico
                    ],
                    max_tokens: 4096,
                });

                const textoBruto = response.choices[0]?.message?.content || '';

                // Extrai somente o que vem após </think> (mesmo sem a tag de abertura <think>)
                let respostaLimpa = textoBruto;
                const indexFechamento = textoBruto.lastIndexOf('</think>');
                if (indexFechamento !== -1) {
                    respostaLimpa = textoBruto.substring(indexFechamento + 8).trim();
                } else {
                    respostaLimpa = textoBruto.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
                }

                if (!respostaLimpa) {
                    respostaLimpa = 'Não consegui gerar uma resposta.';
                }

                historico.push({ role: 'assistant', content: respostaLimpa });
                const historicoRecente = historico.slice(-MAX_HISTORY_MESSAGES);
                await this.historyAccessor.set(context, historicoRecente);

                await context.sendActivity(MessageFactory.text(respostaLimpa, respostaLimpa));
            } catch (error) {
                console.error('Erro ao chamar o Phi-4-reasoning no Azure:', error);
                await context.sendActivity(
                    MessageFactory.text('Desculpe, ocorreu um erro ao processar sua solicitação.')
                );
            }

            await next();
        });

        this.onMembersAdded(async (context, next) => {
            const membersAdded = context.activity.membersAdded ?? [];
            const welcomeText = 'Olá! Sou seu assistente rodando com Phi-4-reasoning no Azure. Digite /limpar para reiniciar a conversa.';

            for (const member of membersAdded) {
                if (member.id !== context.activity.recipient.id) {
                    await context.sendActivity(MessageFactory.text(welcomeText, welcomeText));
                }
            }
            await next();
        });
    }

    public async run(context: TurnContext): Promise<void> {
        await super.run(context);
        await this.conversationState.saveChanges(context, false);
    }
}
