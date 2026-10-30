import {
	ChangeDetectorRef,
	Component,
	HostListener,
	OnDestroy,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { PortariaService } from './core/portaria.service';
import { AuthService } from './core/auth.service';
import { ExitMode, Student, VanDriver, View } from './models/models';
import { AvatarComponent } from './shared/avatar.component';
import { TvComponent } from './tv/tv.component';
import { LoginComponent } from './login.component';

interface NavItem {
	key: View;
	label: string;
	icon: string;
}

@Component({
	selector: 'app-root',
	standalone: true,
	imports: [CommonModule, FormsModule, AvatarComponent, TvComponent, LoginComponent],
	templateUrl: './app.component.html',
})
export class AppComponent implements OnDestroy {
	cardId = '';
	view: View = 'portaria';

	/** A TV abre em outra janela, com o endereço terminado em #tv */
	readonly isTv = location.hash.toLowerCase().startsWith('#tv');

	/** Controle de tela cheia (portaria e TV). */
	fullscreenMode = false;
	/** Só fica true quando o usuário TENTA sair da tela cheia. */
	fullscreenExitPrompt = false;
	fullscreenPinInput = '';
	newFullscreenPin = '';
	fullscreenPinError = '';
	fullscreenPinSuccess = '';
	fullscreenPinSubmitting = false;

	readonly navItems: NavItem[] = [
		{ key: 'portaria', label: 'Portaria', icon: '📡' },
		{ key: 'manual', label: 'Chamada Manual', icon: '📝' },
		{ key: 'van', label: 'Van Escolar', icon: '🚐' },
		{ key: 'inspetora', label: 'Inspetora', icon: '✅' },
		{ key: 'tv', label: 'Televisão', icon: '📺' },
		{ key: 'relatorio', label: 'Relatório Diário', icon: '📊' },
		{ key: 'cadastro', label: 'Cadastrar Aluno', icon: '🎒' },
	];

	now = new Date();
	private readonly timer = setInterval(() => {
		this.now = new Date();
	}, 1000);

	scanning = false;
	detected: Student | null = null;
	confirmed: Student | null = null;
	demoOpen = false;
	flash = false;

	manualGrade = 'all';
	manualSearch = '';
	editingStudent: Student | null = null;
	editDraft: Partial<Student> = {};
	deletingStudentId: string | null = null;
	editError = '';
	editMessage = '';
	/** Aguarda a próxima leitura do leitor RFID para vincular um cartão ao aluno em edição. */
	rfidRegisterMode = false;
	pending: Student | null = null;
	manualConfirmed: Student | null = null;

	reportGrade = '5º Ano A';

	/** Forma de saída escolhida na confirmação: van ou responsável. */
	exitSide: ExitMode = 'RESPONSAVEL';
	/** Nome de quem retirou o aluno (usado quando a saída é com responsável). */
	exitGuardianName = '';

	/** Cadastro/edição de motoristas de van. */
	vanForm: { name: string; plate: string; phone: string; color: string } = {
		name: '',
		plate: '',
		phone: '',
		color: '#C8102E',
	};
	vanFormOpen = false;
	editingVanId: string | null = null;
	vanError = '';
	vanMessage = '';

	cadastroDraft: Partial<Student> = this.newCadastroDraft();
	cadastroMsg = '';
	cadastroError = '';
	readerStatus = 'Leitor desconectado';
	readerConnected = false;
	/** Último UID lido pelo leitor, exibido na tela da portaria. */
	lastUid = '';
	private lastUidAt = 0;
	unknownCard = false;
	guardianChoices: Array<{
		alunoId: number;
		nome: string;
		fotoUrl?: string | null;
	}> = [];
	pendingGuardianUid = '';
	/**
	 * Cartão lido e aguardando a confirmação "é seu filho?".
	 * Nada é enviado à API enquanto este objeto estiver preenchido.
	 */
	childConfirm: {
		uid: string;
		nome: string;
		fotoUrl?: string | null;
		detalhe?: string;
		alunoId?: number;
		/** true quando o aluno já tem chamada pendente na fila. */
		jaChamado?: boolean;
	} | null = null;
	childConfirmBusy = false;
	/** Bloqueia o botão "Sim" da chamada manual durante o envio. */
	manualConfirmBusy = false;
	/** Mensagem de sucesso após confirmar a chamada. */
	successNotice = '';
	apiActionError = '';
	private serialPort: any = null;
	private serialReader: any = null;
	private reading = false;
	/** True enquanto uma leitura de cartão está sendo enviada ao back-end. */
	private readInFlight = false;

	constructor(
		public svc: PortariaService,
		public authService: AuthService,
		private cdr: ChangeDetectorRef,
	) {
		// Define a view padrão e filtra o menu conforme o papel do usuário logado.
		if (authService.isAuthenticated()) {
			this.view = authService.getDefaultView();
		}
	}

	/** Retorna apenas os itens de menu que o usuário logado pode acessar. */
	get filteredNavItems(): NavItem[] {
		if (!this.authService.isAuthenticated()) return [];
		return this.navItems.filter((item) => this.authService.canAccessView(item.key));
	}

	// ---------------------------------------------------------------
	// Tela cheia com código PIN (só para Portaria e TV)
	// ---------------------------------------------------------------
	toggleFullscreen(): void {
		const allowed = this.view === 'portaria' || this.view === 'tv';
		if (!allowed) return;
		if (!this.fullscreenMode) {
			// Entra em tela cheia sem pedir código.
			void this.enterFullscreen();
		} else {
			// Tentou sair: só agora aparece o pedido do PIN.
			this.openFullscreenExitPrompt();
		}
	}

	private async enterFullscreen(): Promise<void> {
		this.fullscreenMode = true;
		this.closeFullscreenExitPrompt();
		try {
			if (!document.fullscreenElement) {
				await document.documentElement.requestFullscreen?.();
			}
		} catch {
			// Navegador pode recusar a API; a tela cheia "virtual" continua ativa.
		}
	}

	private openFullscreenExitPrompt(): void {
		this.fullscreenExitPrompt = true;
		this.fullscreenPinInput = '';
		this.fullscreenPinError = '';
		this.fullscreenPinSuccess = '';
		this.newFullscreenPin = '';
		this.fullscreenPinSubmitting = false;
	}

	cancelFullscreenExit(): void {
		this.closeFullscreenExitPrompt();
	}

	private closeFullscreenExitPrompt(): void {
		this.fullscreenExitPrompt = false;
		this.fullscreenPinInput = '';
		this.fullscreenPinError = '';
	}

	async exitFullscreenWithPin(): Promise<void> {
		if (this.fullscreenPinSubmitting) return;
		this.fullscreenPinError = '';
		if (!this.fullscreenPinInput.trim()) {
			this.fullscreenPinError = 'Digite o código para sair da tela cheia.';
			return;
		}
		this.fullscreenPinSubmitting = true;
		try {
			if (document.fullscreenElement) {
				await document.exitFullscreen?.();
			}
		} catch {
			// Se o navegador recusar, sai apenas da tela cheia "virtual".
		} finally {
			this.fullscreenMode = false;
			this.fullscreenPinSubmitting = false;
			this.closeFullscreenExitPrompt();
		}
	}

	changeFullscreenPin(newPin: string): void {
		const pin = String(newPin ?? '').trim();
		this.fullscreenPinSuccess = '';
		this.fullscreenPinError = '';
		if (!/^[0-9]{4,8}$/.test(pin)) {
			this.fullscreenPinError = 'O código deve ter de 4 a 8 dígitos numéricos.';
			return;
		}
		this.authService.saveFullscreenPin(pin);
		this.newFullscreenPin = '';
		this.fullscreenPinSuccess = 'Código atualizado com sucesso.';
	}

	@HostListener('document:fullscreenchange')
	onFullscreenChange(): void {
		// Fechar a tela cheia do navegador (ESC) também libera o overlay do PIN.
		if (!document.fullscreenElement) {
			this.fullscreenMode = false;
			this.fullscreenPinSubmitting = false;
			this.closeFullscreenExitPrompt();
		}
	}

	ngOnDestroy(): void {
		clearInterval(this.timer);
		void this.disconnectReader();
	}

	/** Conecta ao ESP32 pela porta serial USB usando Web Serial (Chrome/Edge). */
	async connectReader(): Promise<void> {
		const serial = (navigator as any).serial;
		if (!serial) {
			this.readerStatus =
				'Este navegador não oferece Web Serial. Use Chrome ou Edge em localhost/HTTPS.';
			return;
		}
		if (this.readerConnected && this.serialPort) {
			this.readerStatus = 'ESP32 já conectado';
			return;
		}
		// Se já houve autorização antes, reconecta na mesma porta sem pedir de novo.
		if (!this.serialPort && serial.getPorts) {
			try {
				const granted = await serial.getPorts();
				if (granted?.length) this.serialPort = granted[0];
			} catch {
				/* precisa escolher a porta manualmente */
			}
		}
		try {
			if (!this.serialPort) this.serialPort = await serial.requestPort();
			await this.serialPort.open({ baudRate: 115200 });
			this.readerConnected = true;
			this.readerStatus = 'ESP32 conectado — aguardando UID';
			this.reading = true;
			const decoder = new TextDecoderStream();
			const pipePromise = this.serialPort.readable.pipeTo(decoder.writable);
			this.serialReader = decoder.readable.getReader();
			let buffer = '';
			while (this.reading && this.serialReader) {
				const { value, done } = await this.serialReader.read();
				if (done) break;
				buffer += value;
				const lines = buffer.split(/\r?\n/);
				buffer = lines.pop() ?? '';
				for (const line of lines) {
					const uid = this.extractUid(line);
					if (!uid) continue;
					// O ESP32 repete a mesma linha enquanto o cartão fica no leitor:
					// ignora repetições em menos de 2 s para não duplicar a chamada.
					const now = Date.now();
					if (uid === this.lastUid && now - this.lastUidAt < 2000) continue;
					this.lastUid = uid;
					this.lastUidAt = now;
					// Preenche o campo com o UID lido e processa na hora.
					this.cardId = uid;
					this.cdr.markForCheck();
					// Sem await: o loop continua lendo a serial imediatamente.
					// Sem isso, uma leitura lenta bloqueia o leitor e as
					// próximas passadas de cartão são perdidas.
					void this.handleScannedUid(uid);
				}
			}
			await pipePromise.catch(() => undefined);
			if (this.reading) {
				this.readerStatus = 'Leitor desconectado (cabo removido?)';
			}
		} catch (error) {
			this.readerStatus =
				'Não foi possível conectar ao ESP32. Verifique o cabo e a porta selecionada.';
			console.error('Erro no leitor serial', error);
		} finally {
			this.readerConnected = false;
			this.serialReader = null;
			this.serialPort = null;
			this.reading = false;
		}
	}

	/**
	 * Extrai o UID de uma linha enviada pelo ESP32.
	 * Aceita "UID: 04A1B2C3", "04A1B2C3" e "04 A1 B2 C3" e ignora mensagens
	 * de status do firmware (inicialização, "aguardando cartão" etc.).
	 */
	private extractUid(line: string): string {
		const text = String(line ?? '').replace(/\u0000/g, '').trim();
		if (!text) return '';
		// Mensagens de diagnóstico do firmware não são UIDs.
		if (/SISTEMA|RFID|LEITOR|INICIADO|CART[AÃ]O|AGUARDANDO|LENDO/i.test(text))
			return '';
		const explicit = text.match(/UID\s*[:=]?\s*([0-9A-Fa-f\s]{4,32})/i);
		const raw = explicit?.[1] ?? text;
		const uid = raw.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
		// UID RFID tem 4 a 10 bytes (8 a 20 caracteres hex).
		if (uid.length < 4 || uid.length > 20) return '';
		return uid;
	}

	async disconnectReader(): Promise<void> {
		this.reading = false;
		try {
			await this.serialReader?.cancel();
		} catch {
			/* leitor já encerrado */
		}
		try {
			this.serialReader?.releaseLock();
		} catch {
			/* lock já liberado */
		}
		try {
			await this.serialPort?.close();
		} catch {
			/* porta já fechada */
		}
		this.serialReader = null;
		this.serialPort = null;
		this.readerConnected = false;
		this.readerStatus = 'Leitor desconectado';
	}

	private async handleScannedUid(uid: string): Promise<void> {
		// Modo cadastro de cartão no formulário "Cadastrar Aluno": apenas preenche o UID.
		if (this.cadastroRfidMode) {
			const clean = this.normalizeCard(uid);
			const jaEmUso = this.svc
				.students()
				.find((s) => this.normalizeCard(s.rfidCard) === clean);
			this.cardId = '';
			if (jaEmUso) {
				this.cadastroError = `Este cartão já está cadastrado para ${jaEmUso.name}. Aproxime outro cartão.`;
				this.cdr.detectChanges();
				return;
			}
			this.cadastroDraft.rfidCard = clean;
			this.cadastroRfidMode = false;
			this.cadastroError = '';
			this.readerStatus = `UID lido: ${clean}`;
			this.cdr.detectChanges();
			return;
		}

		// Modo cadastro de cartão na edição do aluno: captura o UID lido e
		// preenche o draft, sem consultar o back-end de portaria.
		if (this.rfidRegisterMode) {
			this.cardId = uid;
			this.unknownCard = false;
			this.apiActionError = '';
			this.editError = '';
			this.editMessage = '';
			const clean = this.normalizeCard(uid);
			const jaEmUso = this.svc
				.students()
				.find(
					(s) =>
						s.id !== this.editingStudent?.id &&
						this.normalizeCard(s.rfidCard) === clean,
				);
			if (jaEmUso) {
				this.editError = `Este cartão já está cadastrado para ${jaEmUso.name}. Aproxime outro cartão.`;
				this.cardId = '';
				this.cdr.detectChanges();
				return;
			}
			this.editDraft.rfidCard = clean;
			this.rfidRegisterMode = false;
			this.editMessage = `Cartão ${clean} lido. Clique em "Salvar alterações" para gravar no aluno.`;
			this.readerStatus = `UID lido: ${clean}`;
			this.cardId = '';
			this.cdr.detectChanges();
			return;
		}

		// Identificação local: o cartão lido é de um aluno já carregado?
		const clean = this.normalizeCard(uid);
		const localStudent = this.svc
			.students()
			.find((s) => this.normalizeCard(s.rfidCard) === clean);

		this.cardId = '';
		this.unknownCard = false;
		this.apiActionError = '';
		this.guardianChoices = [];
		this.successNotice = '';

		if (localStudent) {
			// Já está chamado? Mostra o aviso com a opção de reenviar a chamada
			// (o aluno pode ser chamado novamente, ex.: não ouviu o primeiro aviso).
			const jaChamado = this.svc.isCalled(localStudent.id);
			this.childConfirm = {
				uid: clean,
				nome: localStudent.name,
				fotoUrl: localStudent.photo,
				detalhe: `${localStudent.grade} • Turma ${localStudent.class}`,
				alunoId: Number(localStudent.id) || undefined,
				jaChamado,
			};
			if (jaChamado) {
				this.readerStatus = `${localStudent.name} já está na fila. Use "Chamar novamente" se precisar repetir o aviso.`;
			}
			this.readerStatus = `Cartão de ${localStudent.name} lido. Confirme na tela.`;
			return;
		}

		// Não achou localmente: consulta a API apenas para IDENTIFICAR o cartão.
		// ATENÇÃO: /leituras registra a chamada no back-end e coloca o aluno na
		// fila da TV. Por isso ela só pode ser chamada depois do "Sim, é meu
		// filho" — nunca aqui.
		if (this.readInFlight) return;
		this.readInFlight = true;
		try {
			const result = await this.svc.identifyCard(uid);
			if (result.confirmacaoNecessaria) {
				this.pendingGuardianUid = uid;
				this.guardianChoices = result.alunos ?? [];
				this.readerStatus =
					'Cartão de responsável reconhecido. Selecione o aluno.';
				return;
			}
			const aluno = result.aluno;
			if (!aluno) {
				this.unknownCard = true;
				this.readerStatus = 'A API não reconheceu o cartão.';
				return;
			}
			const jaChamado = this.svc.isCalled(aluno.alunoId);
			this.childConfirm = {
				uid,
				nome: aluno.nome,
				fotoUrl: aluno.fotoUrl,
				detalhe: aluno.detalhe,
				alunoId: aluno.alunoId,
				jaChamado,
			};
			if (jaChamado) {
				this.readerStatus = `${aluno.nome} já está na fila. Use "Chamar novamente" se precisar repetir o aviso.`;
			}
			this.readerStatus = `Cartão de ${aluno.nome} lido. Confirme na tela.`;
		} catch (error) {
			console.error('Falha ao identificar o cartão na API', error);
			this.unknownCard = true;
			this.readerStatus =
				'A API não reconheceu o cartão ou não foi possível conectar.';
			this.apiActionError =
				'A leitura não foi processada. Confirme se o cartão está cadastrado e vinculado no back-end e se a API está acessível.';
		} finally {
			this.readInFlight = false;
		}
	}

	/** "Sim, é meu filho": registra a chamada e envia o aluno para a inspetora. */
	async acceptChild(): Promise<void> {
		const current = this.childConfirm;
		if (!current || this.childConfirmBusy) return;
		this.childConfirmBusy = true;
		this.apiActionError = '';
		try {
			const student = current.alunoId
				? this.svc
						.students()
						.find((s) => s.id === String(current.alunoId))
				: undefined;
			if (student) {
				await this.svc.callManual(student);
			} else {
				await this.svc.confirmGuardianRead(current.uid, current.alunoId ?? 0);
				await this.svc.loadStudents();
			}
			this.successNotice = current.jaChamado
				? `Chamada de ${current.nome} reenviada para a TV.`
				: `${current.nome} foi avisado(a) e está a caminho da portaria.`;
			this.readerStatus = 'Chamada enviada para a inspetora.';
			this.childConfirm = null;
		} catch (error) {
			console.error('Falha ao confirmar a chamada do aluno', error);
			this.apiActionError =
				'Não foi possível registrar a chamada no back-end.';
		} finally {
			this.childConfirmBusy = false;
		}
	}

	/** "Não, tentar novamente": descarta o cartão e volta a aguardar a leitura. */
	retryCardRead(): void {
		this.childConfirm = null;
		this.childConfirmBusy = false;
		this.successNotice = '';
		this.unknownCard = false;
		this.apiActionError = '';
		this.cardId = '';
		this.lastUid = '';
		this.lastUidAt = 0;
		this.readerStatus = 'Aguardando novo cartão...';
		this.focusRfidInput();
	}

	/** Devolve o foco ao campo invisivel para o leitor USB continuar funcionando. */
	private focusRfidInput(): void {
		setTimeout(() => {
			const input = document.querySelector<HTMLInputElement>('.rfid-input');
			input?.focus({ preventScroll: true });
		}, 0);
	}

	async confirmGuardianStudent(choice: {
		alunoId: number;
		nome: string;
		fotoUrl?: string | null;
	}): Promise<void> {
		try {
			await this.svc.confirmGuardianRead(
				this.pendingGuardianUid,
				choice.alunoId,
			);
			await this.svc.loadStudents();
			this.confirmed =
				this.svc
					.students()
					.find((student) => student.id === String(choice.alunoId)) ?? null;
			this.guardianChoices = [];
			this.pendingGuardianUid = '';
			this.cardId = '';
			this.readerStatus = `Chamada registrada para ${choice.nome}.`;
			if (this.confirmed) setTimeout(() => (this.confirmed = null), 3500);
		} catch (error) {
			console.error('Falha ao confirmar aluno do responsável', error);
			this.apiActionError =
				'Não foi possível confirmar o aluno para este cartão de responsável.';
		}
	}

	reloadStudents(): void {
		// Reconsulta a API (útil quando o back-end sobe depois da página).
		void this.svc.loadStudents();
		void this.svc.loadQueue();
	}

	toggleTheme(): void {
		this.svc.toggleTheme();
	}

	@HostListener('document:keydown.escape')
	onEscape(): void {
		// Com o pedido de PIN aberto, ESC apenas cancela (a tela cheia continua).
		if (this.fullscreenExitPrompt) {
			this.cancelFullscreenExit();
			return;
		}
		if (this.fullscreenMode) return;
		this.cardId = '';
		this.detected = null;
		this.demoOpen = false;
		this.guardianChoices = [];
		this.pendingGuardianUid = '';
	}

	openTv(): void {
		window.open(`${location.pathname}#tv`, 'portaria-tv');
	}

	@HostListener('document:click')
	onDocumentClick(): void {
		// O leitor USB "digita" como teclado: o campo invisivel precisa estar
		// focado. Cliques no meio do conteudo devolvem o foco para ele.
		if (this.view !== 'portaria' || !this.authService.isAuthenticated()) return;
		const active = document.activeElement as HTMLElement | null;
		if (active?.closest('input, select, textarea, button, a')) return;
		this.focusRfidInput();
	}

	nav(view: View): void {
		if (!this.authService.canAccessView(view)) return;
		this.fullscreenMode = false;
		this.closeFullscreenExitPrompt();
		if (document.fullscreenElement) void document.exitFullscreen?.();
		if (view === 'tv') {
			this.openTv();
			return;
		}
		this.view = view;
		this.cardId = '';
		this.pending = null;
		this.detected = null;
		this.demoOpen = false;
	}

	get pageTitle(): string {
		return this.navItems.find((x) => x.key === this.view)?.label ?? 'Portaria';
	}

	get pageSubtitle(): string {
		switch (this.view) {
			case 'portaria':
				return 'Leitor RFID — Saída de Alunos';
			case 'manual':
				return 'Seleção pela Inspetora';
			case 'van':
				return 'Gestão de motoristas e alunos';
			case 'inspetora':
				return 'Confirmação de Saída';
			case 'tv':
				return 'Painel de Chamada — abre em outra janela';
			case 'relatorio':
				return 'Histórico de saídas da sessão';
			case 'cadastro':
				return 'Cadastro de novos alunos';
		}
	}

	get queueCount(): number {
		return this.svc.queue().length;
	}

	get exitCount(): number {
		return this.svc.exits().length;
	}

	get manualHasFilter(): boolean {
		return true;
	}

	get manualStudents(): Student[] {
		if (!this.manualHasFilter) return [];
		const q = this.manualSearch.trim().toLowerCase();
		return this.svc.students().filter((student) => {
			const normalizedGrade =
				student.grade === '5º Ano' ? `5º Ano ${student.class}` : student.grade;
			const matchesGrade =
				this.manualGrade === 'all' ||
				normalizedGrade === this.manualGrade ||
				(this.manualGrade === '5º Ano A' &&
					student.grade === '5º Ano' &&
					student.class === 'A') ||
				(this.manualGrade === '5º Ano B' &&
					student.grade === '5º Ano' &&
					student.class === 'B');
			const matchesName = !q || student.name.toLowerCase().includes(q);
			return matchesGrade && matchesName;
		});
	}

	get reportByMode() {
		const exits = this.svc.exits();
		return {
			van: exits.filter((x) => x.mode === 'VAN').length,
			responsavel: exits.filter((x) => x.mode === 'RESPONSAVEL').length,
		};
	}

	get reportRows() {
		if (this.reportGrade === 'all') return this.svc.exits();
		// O filtro usa o rótulo da turma (ex.: "5º Ano A").
		const match = /^(\d+º Ano) ([AB])$/.exec(this.reportGrade);
		const grade = match?.[1] ?? this.reportGrade;
		const className = match?.[2];
		return this.svc
			.exits()
			.filter(
				(record) =>
					record.student.grade === grade &&
					(!className || record.student.class === className),
			);
	}

	get reportByGrade() {
		const grades = ['1º Ano', '2º Ano', '3º Ano', '4º Ano', '5º Ano'];
		return grades.map((grade) => ({
			grade,
			count: this.svc.exits().filter((x) => x.student.grade === grade).length,
			total: this.svc.students().filter((x) => x.grade === grade).length,
		}));
	}

	get vanStudents(): Student[] {
		return this.svc.students().filter((student) => student.isVan);
	}

	get nonVanStudents(): Student[] {
		return this.svc.students().filter((student) => !student.isVan);
	}

	get activeVanCalls() {
		return this.svc.vanCalls();
	}

	get activeVanCall() {
		return this.svc.vanCall();
	}

	isQueued(student: Student): boolean {
		return this.svc.queue().some((item) => item.student.id === student.id);
	}

	initials(student: Student): string {
		if (student.avatarInitials) return student.avatarInitials;
		return student.name
			.split(' ')
			.filter(Boolean)
			.slice(0, 2)
			.map((part) => part[0])
			.join('')
			.toUpperCase();
	}

	time(date: Date): string {
		return date.toLocaleTimeString('pt-BR', {
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
		});
	}

	short(date: Date): string {
		return date.toLocaleTimeString('pt-BR', {
			hour: '2-digit',
			minute: '2-digit',
		});
	}

	dateLabel(date: Date): string {
		return date.toLocaleDateString('pt-BR', {
			weekday: 'long',
			day: 'numeric',
			month: 'long',
		});
	}

	onCardInput(): void {
		// Leitores que funcionam como teclado enviam o UID e pressionam Enter.
		// A consulta oficial é feita em onCardScanned() diretamente no back-end.
	}

	async onCardScanned(): Promise<void> {
		const value = this.normalizeCard(this.cardId);
		if (value) await this.handleScannedUid(value);
	}

	private normalizeCard(value: unknown): string {
		return String(value ?? '')
			.trim()
			.toUpperCase()
			.replace(/\s+/g, '');
	}

	simulateScan(student: Student): void {
		if (this.scanning || this.detected || this.isQueued(student)) return;

		this.demoOpen = false;
		this.scanning = true;
		this.confirmed = null;

		setTimeout(() => {
			this.scanning = false;
			this.detected = student;
		}, 900);
	}

	async confirmDetected(): Promise<void> {
		if (!this.detected || this.isQueued(this.detected)) return;
		const student = this.detected;
		try {
			await this.svc.callManual(student);
			this.confirmed = student;
			this.detected = null;
			this.flash = true;
			setTimeout(() => (this.flash = false), 700);
			setTimeout(() => (this.confirmed = null), 3000);
		} catch (error) {
			console.error('Falha ao registrar chamada manual', error);
			this.apiActionError = 'Não foi possível registrar a chamada no back-end.';
		}
	}

	cancelDetected(): void {
		this.detected = null;
	}

	/** Abre o aviso "é seu filho?" para a chamada manual (nada é enviado ainda). */
	selectManual(student: Student): void {
		// Mesmo que o aluno já esteja na fila, abre o aviso: ele pode querer
		// reenviar a chamada (aluno não ouviu o aviso na TV).
		this.pending = student;
		this.manualConfirmed = null;
		this.apiActionError = '';
		this.successNotice = '';
		// Fecha o aviso de leitura do cartão, se estiver aberto.
		this.childConfirm = null;
	}

	/**
	 * "Sim, é meu filho" na chamada manual: só aqui o aluno é enviado ao
	 * back-end (POST /chamadas/manual) e aparece na fila e na TV.
	 */
	async confirmManual(): Promise<void> {
		const student = this.pending;
		if (!student || this.manualConfirmBusy) return;
		const jaChamado = this.svc.isCalled(student.id);
		this.manualConfirmBusy = true;
		this.apiActionError = '';
		try {
			await this.svc.callManual(student);
			this.manualConfirmed = student;
			this.successNotice = jaChamado
				? `Chamada de ${student.name} reenviada para a TV.`
				: `${student.name} foi avisado(a) e está a caminho da portaria.`;
			this.pending = null;
			setTimeout(() => (this.manualConfirmed = null), 4000);
		} catch (error) {
			console.error('Falha ao registrar chamada manual', error);
			this.apiActionError =
				'Não foi possível registrar a chamada manual no back-end.';
		} finally {
			this.manualConfirmBusy = false;
		}
	}

	/** "Não — tentar novamente": fecha o aviso e volta à lista de alunos. */
	cancelManual(): void {
		this.pending = null;
		this.manualConfirmBusy = false;
		this.successNotice = '';
	}

	/** Nome do motorista vinculado ao aluno (vazio quando não houver). */
	editDriverName(student: Student): string {
		return this.svc.driverName(student.vanDriverId);
	}

	/** Prepara a confirmação de saída de um aluno da fila. A forma de saída
	 *  (van ou responsável) é identificada automaticamente pelo vínculo do aluno. */
	prepareExit(student: Student): void {
		this.pending = student;
		this.manualConfirmed = null;
		this.exitSide =
			student.isVan && student.vanDriverId ? 'VAN' : 'RESPONSAVEL';
		this.exitGuardianName =
			student.parentName && student.parentName !== 'Não informado'
				? student.parentName
				: 'Responsável';
	}

	cancelExit(): void {
		this.pending = null;
	}

	/** Confirma a saída sem pedir nada à inspetora. */
	async confirmExit(queueId: string): Promise<void> {
		this.apiActionError = '';
		const student = this.svc
			.queue()
			.find((item) => item.id === queueId)?.student;
		if (!student) return;
		this.prepareExit(student);
		try {
			await this.svc.confirmExit(queueId, this.exitSide, this.exitGuardianName);
			this.pending = null;
		} catch (error) {
			console.error('Falha ao confirmar saída', error);
			this.apiActionError = 'Não foi possível confirmar a saída no back-end.';
		}
	}

	// ---------------------------------------------------------------
	// Cadastro de vans / motoristas
	// ---------------------------------------------------------------
	private newVanForm() {
		return { name: '', plate: '', phone: '', color: '#C8102E' };
	}

	startVanForm(): void {
		this.vanFormOpen = true;
		this.editingVanId = null;
		this.vanForm = this.newVanForm();
		this.vanError = '';
	}

	editVan(driver: VanDriver): void {
		this.vanFormOpen = true;
		this.editingVanId = driver.id;
		this.vanForm = {
			name: driver.name,
			plate: driver.plate,
			phone: driver.phone || '',
			color: driver.color,
		};
		this.vanError = '';
		this.vanMessage = '';
	}

	cancelVanForm(): void {
		this.vanFormOpen = false;
		this.editingVanId = null;
		this.vanForm = this.newVanForm();
		this.vanError = '';
	}

	saveVan(): void {
		this.vanError = '';
		this.vanMessage = '';
		if (!this.vanForm.name.trim()) {
			this.vanError = 'Informe o nome do motorista.';
			return;
		}
		const duplicated = this.svc
			.vanDrivers()
			.some(
				(driver) =>
					driver.id !== this.editingVanId &&
					driver.name.trim().toLowerCase() ===
						this.vanForm.name.trim().toLowerCase(),
			);
		if (duplicated) {
			this.vanError = 'Já existe um motorista com esse nome.';
			return;
		}
		if (this.editingVanId) {
			this.svc.updateVanDriver(this.editingVanId, this.vanForm);
			this.vanMessage = 'Motorista atualizado.';
		} else {
			this.svc.addVanDriver(this.vanForm);
			this.vanMessage = 'Motorista cadastrado.';
		}
		this.cancelVanForm();
	}

	removeVan(driver: VanDriver): void {
		if (
			!confirm(
				`Excluir o motorista ${driver.name}? Os alunos vinculados ficarão sem motorista.`,
			)
		)
			return;
		this.svc.removeVanDriver(driver.id);
		this.vanMessage = 'Motorista removido.';
		if (this.editingVanId === driver.id) this.cancelVanForm();
	}

	driverStudents(driver: VanDriver): Student[] {
		return this.svc.studentsByDriver(driver.id);
	}

	callDriver(driver: VanDriver): void {
		this.svc.callDriver(driver);
	}

	endVanCall(driverId?: string): void {
		this.svc.endVanCall(driverId);
	}

	onEditVanChange(isVan: boolean): void {
		// Ao desmarcar a van, o vínculo com o motorista deixa de fazer sentido.
		if (!isVan) this.editDraft.vanDriverId = undefined;
	}

	onCadastroVanChange(isVan: boolean): void {
		if (!isVan) this.cadastroDraft.vanDriverId = undefined;
	}

	editStudent(student: Student): void {
		this.editingStudent = student;
		this.editDraft = { ...student };
		this.editError = '';
		this.editMessage = '';
	}

	cancelEditStudent(): void {
		this.editingStudent = null;
		this.editDraft = {};
		this.editError = '';
		this.rfidRegisterMode = false;
	}

	/** Inicia a leitura do próximo cartão aproximado para vinculá-lo ao aluno em edição. */
	registerRfidForEdit(): void {
		if (!this.editingStudent) return;
		this.editError = '';
		this.editMessage = '';
		this.rfidRegisterMode = true;
		this.cardId = '';
		if (!this.readerConnected) {
			// Abre o seletor de porta do Web Serial na hora do cadastro.
			this.readerStatus = 'Conecte o leitor ESP32 para capturar o cartão...';
			void this.connectReader();
		}
		this.readerStatus = this.readerConnected
			? 'Aproxime o cartão do leitor para cadastrar o UID.'
			: this.readerStatus;
	}

	cancelRegisterRfid(): void {
		this.rfidRegisterMode = false;
		this.cardId = '';
		this.editMessage = '';
		this.editError = '';
	}

	onEditPhotoSelected(event: Event): void {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		if (!file.type.startsWith('image/')) {
			this.editError = 'Selecione um arquivo de imagem.';
			input.value = '';
			return;
		}
		const reader = new FileReader();
		reader.onload = () => {
			const img = new Image();
			img.onload = () => {
				const size = 400;
				const side = Math.min(img.width, img.height);
				const canvas = document.createElement('canvas');
				canvas.width = size;
				canvas.height = size;
				canvas
					.getContext('2d')!
					.drawImage(
						img,
						(img.width - side) / 2,
						(img.height - side) / 2,
						side,
						side,
						0,
						0,
						size,
						size,
					);
				this.editDraft.photo = canvas.toDataURL('image/jpeg', 0.82);
				this.cdr.detectChanges();
			};
			img.src = reader.result as string;
		};
		reader.readAsDataURL(file);
		input.value = '';
	}

	removeEditPhoto(): void {
		this.editDraft.photo = undefined;
	}

	async deleteStudent(student: Student): Promise<void> {
		const confirmed = window.confirm(
			`Tem certeza que deseja excluir o aluno ${student.name}? Esta ação não poderá ser desfeita.`,
		);
		if (!confirmed) return;
		this.editError = '';
		this.editMessage = '';
		try {
			await this.svc.deleteStudent(student.id);
			if (this.editingStudent?.id === student.id) this.cancelEditStudent();
			this.editMessage = `${student.name} foi excluído(a).`;
		} catch (error) {
			console.error('Falha ao excluir aluno', error);
			this.editError =
				'Não foi possível excluir pela API. Verifique se o back-end implementa DELETE /api/alunos/{id}.';
		}
	}

	async saveStudentEdit(): Promise<void> {
		this.editError = '';
		this.editMessage = '';
		if (!this.editingStudent || !this.editDraft.name?.trim()) {
			this.editError = 'Informe o nome do aluno.';
			return;
		}
		if (this.editDraft.isVan && !this.editDraft.vanDriverId) {
			this.editError = 'Selecione o motorista da van do aluno.';
			return;
		}
		try {
			const updated: Student = {
				...this.editingStudent,
				...this.editDraft,
				name: this.editDraft.name.trim(),
				grade: this.editDraft.grade || '5º Ano',
				class: this.editDraft.class || 'A',
			} as Student;
			const alunoId = this.editingStudent.id;
			await this.svc.updateStudent(updated);
			// Vincula o cartão RFID informado/ lido na edição, quando diferente do atual.
			const novoUid = this.normalizeCard(this.editDraft.rfidCard);
			const uidAtual = this.normalizeCard(this.editingStudent.rfidCard);
			if (novoUid && novoUid !== uidAtual) {
				try {
					await this.svc.registerCard(alunoId, novoUid);
					await this.svc.loadStudents();
				} catch (error) {
					console.error('Falha ao vincular cartão RFID', error);
					this.editError = `Dados do aluno salvos, mas o cartão ${novoUid} não foi vinculado. Verifique se o UID já pertence a outro cadastro (POST /api/cartoes).`;
					return;
				}
			}
			this.rfidRegisterMode = false;
			this.editMessage = novoUid && novoUid !== uidAtual
				? 'Dados e cartão RFID atualizados.'
				: 'Dados atualizados.';
			this.editingStudent = null;
			this.editDraft = {};
		} catch (error) {
			console.error('Falha ao editar aluno', error);
			this.editError =
				'Não foi possível salvar a edição na API. Confira o endpoint PUT /api/alunos/{id}.';
		}
	}

	resetCadastro(): void {
		this.cadastroDraft = this.newCadastroDraft();
		this.cadastroError = '';
	}

	get cadastroValid(): boolean {
		const d = this.cadastroDraft;
		return !!(
			d.name?.trim() &&
			d.grade &&
			d.class?.trim() &&
			d.email?.trim() &&
			d.cpf?.trim() &&
			d.birthDate &&
			d.parentName?.trim() &&
			d.guardianPhone?.trim()
		);
	}

	onPhotoSelected(event: Event): void {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;

		const reader = new FileReader();
		reader.onload = () => {
			const img = new Image();
			img.onload = () => {
				// Recorta no centro (quadrado) e reduz para não pesar no armazenamento.
				const size = 400;
				const side = Math.min(img.width, img.height);
				const canvas = document.createElement('canvas');
				canvas.width = size;
				canvas.height = size;
				canvas
					.getContext('2d')!
					.drawImage(
						img,
						(img.width - side) / 2,
						(img.height - side) / 2,
						side,
						side,
						0,
						0,
						size,
						size,
					);
				this.cadastroDraft.photo = canvas.toDataURL('image/jpeg', 0.82);
				this.cdr.detectChanges();
			};
			img.src = reader.result as string;
		};
		reader.readAsDataURL(file);
		input.value = '';
	}

	removePhoto(): void {
		this.cadastroDraft.photo = undefined;
	}

	async saveCadastro(): Promise<void> {
		this.cadastroMsg = '';
		this.cadastroError = '';
		if (!this.cadastroValid) return;

		const d = this.cadastroDraft;
		try {
			const student = await this.svc.addStudent({
				name: d.name!.trim(),
				grade: d.grade!,
				class: d.class!.trim().toUpperCase(),
				parentName: d.parentName!.trim(),
				parentRelation: d.parentRelation || 'Mãe',
				email: d.email?.trim(),
				cpf: d.cpf?.trim(),
				birthDate: d.birthDate,
				guardianPhone: d.guardianPhone?.trim(),
				rfidCard: this.normalizeCard(d.rfidCard),
				avatarColor: '#C8102E',
				isVan: !!d.isVan,
				vanDriverId: d.isVan ? d.vanDriverId : undefined,
				photo: d.photo,
			});
			this.cadastroMsg = d.rfidCard?.trim()
				? `${student.name} foi cadastrado(a) com o cartão ${this.normalizeCard(d.rfidCard)}.`
				: `${student.name} foi cadastrado(a) com sucesso.`;
			this.cadastroRfidMode = false;
			this.cadastroDraft = this.newCadastroDraft();
		} catch (error) {
			console.error('Falha ao cadastrar aluno na API', error);
			this.cadastroError =
				'Não foi possível salvar o aluno no back-end. Verifique se a API está ativa e se o endpoint POST /api/alunos está configurado.';
		}
	}

	private newCadastroDraft(): Partial<Student> {
		return {
			name: '',
			grade: '',
			class: '',
			parentName: '',
			parentRelation: 'Mãe',
			email: '',
			cpf: '',
			birthDate: '',
			guardianPhone: '',
			rfidCard: '',
			isVan: false,
			vanDriverId: undefined,
			photo: undefined,
		};
	}

	// ---------------------------------------------------------------
	// Cadastro de aluno: captura do cartão RFID pelo leitor
	// ---------------------------------------------------------------
	/** True enquanto aguarda a aproximação do cartão no formulário de cadastro. */
	cadastroRfidMode = false;

	registerRfidForCadastro(): void {
		this.cadastroError = '';
		this.cadastroMsg = '';
		this.cadastroRfidMode = true;
		if (!this.readerConnected) {
			this.readerStatus = 'Conecte o leitor ESP32 para capturar o cartão...';
			void this.connectReader();
		}
		this.readerStatus = this.readerConnected
			? 'Aproxime o cartão do leitor para preencher o UID.'
			: this.readerStatus;
	}

	cancelRegisterRfidCadastro(): void {
		this.cadastroRfidMode = false;
	}

	printReport(): void {
		window.print();
	}
}
