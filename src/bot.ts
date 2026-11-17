import {
    ActivityHandler,
    MessageFactory,
    ConversationState,
    StatePropertyAccessor,
    TurnContext
} from 'botbuilder';
import OpenAI from 'openai';

/**
 * Representa uma mensagem estruturada no formato aceito pela API de Chat Completions da OpenAI.
 */
interface ChatMessage {
    /**
     * O papel do remetente da mensagem no diálogo.
     * Pode ser `system` (instruções gerais), `user` (mensagem do usuário) ou `assistant` (resposta gerada pela IA).
     */
    role: 'system' | 'user' | 'assistant';

    /**
     * O conteúdo textual da mensagem.
     */
    content: string;
}

/** Chave identificadora do acessor de estado para o histórico da conversa no Bot Framework. */
const CONVERSATION_HISTORY_PROPERTY = 'conversationHistoryProperty';

/** Número máximo de mensagens recentes armazenadas no histórico para manter o contexto sem estourar a janela de tokens. */
const MAX_HISTORY_MESSAGES = 20;

/**
 * Classe principal do bot, responsável pelo gerenciamento dos eventos de conversação,
 * persistência do histórico via Bot Framework SDK v4 e integração com o modelo Phi-4 no Azure AI Foundry.
 *
 * @extends ActivityHandler
 */
export class EchoBot extends ActivityHandler {
    /**
     * Cliente da biblioteca oficial da OpenAI configurado para se comunicar
     * com o endpoint compatível do Azure AI Foundry (`/openai/v1`).
     */
    private client: OpenAI;

    /**
     * Nome do modelo de linguagem a ser consumido no Azure AI Foundry (ex.: `Phi-4-reasoning` ou `Phi-4-mini-instruct`).
     */
    private modelName: string;

    /**
     * Instância de gerenciamento de estado de conversa do Bot Framework.
     * Persiste dados contextuais do canal e da conversa entre diferentes turnos de mensagens.
     */
    private conversationState: ConversationState;

    /**
     * Acessor de propriedade tipado responsável por ler e gravar o histórico de mensagens (`ChatMessage[]`)
     * dentro do `ConversationState`.
     */
    private historyAccessor: StatePropertyAccessor<ChatMessage[]>;

    /**
     * Inicializa uma nova instância de {@link EchoBot}.
     *
     * @param conversationState - O estado de conversação fornecido pelo adaptador do Bot Framework para gerenciar a sessão.
     */
    constructor(conversationState: ConversationState) {
        super();

        this.conversationState = conversationState;
        this.historyAccessor = this.conversationState.createProperty<ChatMessage[]>(
            CONVERSATION_HISTORY_PROPERTY
        );

        this.modelName = process.env.AZURE_PHI_MODEL || 'Phi-4-reasoning';

        // Conecta ao endpoint /openai/v1 do Azure AI Foundry utilizando a biblioteca cliente da OpenAI
        this.client = new OpenAI({
            baseURL: process.env.AZURE_PHI_ENDPOINT,
            apiKey: process.env.AZURE_PHI_API_KEY,
        });

        // Manipulador disparado sempre que uma mensagem de texto é recebida do usuário
        this.onMessage(async (context, next) => {
            const textoUsuario = context.activity.text.trim();

            // Comando reservado para resetar o histórico acumulado na conversa
            if (textoUsuario.toLowerCase() === '/limpar') {
                await this.historyAccessor.set(context, []);
                await context.sendActivity(MessageFactory.text('Histórico apagado. Como posso ajudar?'));
                await next();
                return;
            }

            try {
                // Exibe indicador visual de digitação no cliente enquanto o modelo gera a resposta
                await context.sendActivity({ type: 'typing' });

                // Recupera o histórico atual da conversa mantido no ConversationState
                const historico = await this.historyAccessor.get(context, []);
                historico.push({ role: 'user', content: textoUsuario });

                // Chama a API OpenAI-compatível do Azure AI Foundry com o prompt de sistema e o histórico
                const response = await this.client.chat.completions.create({
                    model: this.modelName,
                    messages: [
                        { role: 'system', content: 'Você é um assistente virtual útil e direto. Não faça análises longas; responda de forma imediata, curta e sempre em português.' },
                        ...historico
                    ],
                    max_tokens: 4096,
                });

                const textoBruto = response.choices[0]?.message?.content || '';

                /**
                 * Filtro de limpeza para modelos de raciocínio da família Phi-4 (ex.: Phi-4-reasoning).
                 * O modelo gera internamente o raciocínio em cadeia (Chain-of-Thought) delimitado por tags <think>...</think>.
                 * Para garantir que apenas a resposta final seja exibida ao usuário, extrai-se o conteúdo que sucede a tag </think>.
                 * Caso a tag de fechamento não exista, remove-se qualquer ocorrência em bloco via expressão regular.
                 */
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

                // Salva a resposta do assistente no histórico e aplica limite deslizante das últimas mensagens
                historico.push({ role: 'assistant', content: respostaLimpa });
                const historicoRecente = historico.slice(-MAX_HISTORY_MESSAGES);
                await this.historyAccessor.set(context, historicoRecente);

                // Envia a resposta limpa para o usuário no canal
                await context.sendActivity(MessageFactory.text(respostaLimpa, respostaLimpa));
            } catch (error) {
                console.error('Erro ao chamar o Phi-4-reasoning no Azure:', error);
                await context.sendActivity(
                    MessageFactory.text('Desculpe, ocorreu um erro ao processar sua solicitação.')
                );
            }

            await next();
        });

        // Manipulador disparado quando novos membros entram na conversa (boas-vindas)
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

    /**
     * Sobrescreve o método de execução do turno para garantir a persistência das alterações de estado.
     *
     * Executa o manipulador de turnos padrão da classe base {@link ActivityHandler} e, ao término,
     * persiste qualquer alteração feita no {@link ConversationState} durante a requisição.
     *
     * @param context - O contexto do turno atual que contém as informações da atividade e do canal.
     * @returns Uma promessa resolvida quando o processamento do turno e o salvamento do estado forem concluídos.
     */
    public async run(context: TurnContext): Promise<void> {
        await super.run(context);
        await this.conversationState.saveChanges(context, false);
    }
}
