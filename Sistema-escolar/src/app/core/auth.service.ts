import { Injectable, signal, computed, effect, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { API_BASE_URL } from './api.config';
import { View } from '../models/models';

export type Role = 'ADMIN' | 'PORTARIA' | 'INSPIRATORA' | 'TV';

export interface AuthUser {
	id: string;
	name: string;
	role: Role;
}

interface LoginRequest {
	username: string;
	password: string;
}

interface LoginResponse {
	user: { id: string; name: string; role: string };
	token: string;
}

const TOKEN_KEY = 'portaria-session-token';
const USER_KEY = 'portaria-session-user';
const ATTEMPTS_KEY = 'portaria-login-attempts';
const LOCKOUT_KEY = 'portaria-lockout-until';
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60 * 1000; // 5 minutos
const INACTIVITY_MS = 15 * 60 * 1000; // 15 minutos de inatividade
const FULLSCREEN_PIN_KEY = 'portaria-fullscreen-pin';

const DEMO_USERS: Array<{ username: string; password: string; user: AuthUser }> = [
	{ username: 'admin', password: 'Admin@123', user: { id: '1', name: 'Administrador', role: 'ADMIN' } },
	{ username: 'portaria', password: 'Portaria@123', user: { id: '2', name: 'Portaria', role: 'PORTARIA' } },
	{ username: 'inspetora', password: 'Inspetora@123', user: { id: '3', name: 'Inspetora', role: 'INSPIRATORA' } },
	{ username: 'tv', password: 'Tv@123', user: { id: '4', name: 'Televisão', role: 'TV' } },
];

@Injectable({ providedIn: 'root' })
export class AuthService {
	private readonly http = inject(HttpClient);

	readonly token = signal<string | null>(this.readToken());
	readonly user = signal<AuthUser | null>(this.readUser());
	readonly isAuthenticated = computed(() => !!this.token() && !!this.user());
	readonly isAdmin = computed(() => this.user()?.role === 'ADMIN');
	readonly isPortaria = computed(() => this.user()?.role === 'PORTARIA');
	readonly isInspetora = computed(() => this.user()?.role === 'INSPIRATORA');
	readonly isTvRole = computed(() => this.user()?.role === 'TV');
	readonly role = computed(() => this.user()?.role ?? null);

	/** Views permitidas por role. */
	private readonly allowedViews: Record<Role, View[]> = {
		ADMIN: ['portaria', 'manual', 'van', 'inspetora', 'tv', 'relatorio', 'cadastro'],
		PORTARIA: ['portaria'],
		INSPIRATORA: ['manual', 'inspetora', 'van'],
		TV: ['tv'],
	};

	/** Default view ao logar por role. */
	private readonly defaultView: Record<Role, View> = {
		ADMIN: 'portaria',
		PORTARIA: 'portaria',
		INSPIRATORA: 'manual',
		TV: 'tv',
	};

	canAccessView(view: View): boolean {
		const role = this.user()?.role;
		if (!role) return false;
		return this.allowedViews[role]?.includes(view) ?? false;
	}

	getDefaultView(): View {
		const role = this.user()?.role;
		if (!role) return 'portaria';
		return this.defaultView[role] ?? 'portaria';
	}

	// ---------------------------------------------------------------
	// Código PIN para sair da tela cheia (portaria e TV)
	// ---------------------------------------------------------------
	readFullscreenPin(): string {
		try {
			return sessionStorage.getItem(FULLSCREEN_PIN_KEY) ?? '1234';
		} catch { return '1234'; }
	}

	saveFullscreenPin(pin: string): void {
		try {
			sessionStorage.setItem(FULLSCREEN_PIN_KEY, pin);
		} catch { /* armazenamento opcional */ }
	}

	private inactivityTimer?: ReturnType<typeof setTimeout>;
	private lastActivity = Date.now();

	constructor() {
		this.restoreSession();
		this.setupInactivityListener();
		this.scheduleSessionCheck();
	}

	private readToken(): string | null {
		try {
			return sessionStorage.getItem(TOKEN_KEY);
		} catch { return null; }
	}

	private readUser(): AuthUser | null {
		try {
			const raw = sessionStorage.getItem(USER_KEY);
			if (!raw) return null;
			const parsed = JSON.parse(raw) as AuthUser;
			return parsed.id && parsed.name ? parsed : null;
		} catch { return null; }
	}

	private writeSession(token: string, user: AuthUser): void {
		try {
			sessionStorage.setItem(TOKEN_KEY, token);
			sessionStorage.setItem(USER_KEY, JSON.stringify(user));
		} catch { /* armazenamento opcional */ }
		this.token.set(token);
		this.user.set(user);
		this.lastActivity = Date.now();
		this.resetInactivityTimer();
	}

	private clearSession(): void {
		try {
			sessionStorage.removeItem(TOKEN_KEY);
			sessionStorage.removeItem(USER_KEY);
		} catch { /* armazenamento opcional */ }
		this.token.set(null);
		this.user.set(null);
		this.lastActivity = Date.now();
		this.stopInactivityTimer();
	}

	private restoreSession(): void {
		const until = this.readLockout();
		if (until && Date.now() < until) {
			// Bloqueado: não permite login até expirar.
			return;
		}
		if (this.token() && this.user()) {
			this.resetInactivityTimer();
		}
	}

	private setupInactivityListener(): void {
		if (typeof document === 'undefined') return;
		const events = ['mousemove', 'keydown', 'scroll', 'click', 'touchstart'];
		const onActivity = () => {
			if (!this.isAuthenticated()) return;
			this.lastActivity = Date.now();
			this.resetInactivityTimer();
		};
		for (const evt of events) {
			document.addEventListener(evt, onActivity, { passive: true });
		}
		this.resetInactivityTimer();
	}

	private resetInactivityTimer(): void {
		this.stopInactivityTimer();
		this.inactivityTimer = setTimeout(() => {
			this.logout('Sessão expirada por inatividade.');
		}, INACTIVITY_MS);
	}

	private stopInactivityTimer(): void {
		if (this.inactivityTimer) clearTimeout(this.inactivityTimer);
		this.inactivityTimer = undefined;
	}

	private scheduleSessionCheck(): void {
		setInterval(() => {
			if (!this.isAuthenticated()) return;
			const idle = Date.now() - this.lastActivity;
			if (idle >= INACTIVITY_MS) {
				this.logout('Sessão expirada por inatividade.');
			}
		}, 60000);
	}

	private readLockout(): number | null {
		try {
			const raw = sessionStorage.getItem(LOCKOUT_KEY);
			if (!raw) return null;
			return Number(raw);
		} catch { return null; }
	}

	private setLockout(): void {
		try {
			sessionStorage.setItem(LOCKOUT_KEY, String(Date.now() + LOCKOUT_MS));
		} catch { /* armazenamento opcional */ }
	}

	private clearLockout(): void {
		try {
			sessionStorage.removeItem(LOCKOUT_KEY);
			sessionStorage.removeItem(ATTEMPTS_KEY);
		} catch { /* armazenamento opcional */ }
	}

	private incrementAttempts(): number {
		try {
			const current = Number(sessionStorage.getItem(ATTEMPTS_KEY) ?? '0');
			const next = current + 1;
			sessionStorage.setItem(ATTEMPTS_KEY, String(next));
			return next;
		} catch { return 0; }
	}

	isLockedOut(): boolean {
		const until = this.readLockout();
		return Boolean(until && Date.now() < until);
	}

	remainingLockoutMs(): number {
		const until = this.readLockout();
		return until ? Math.max(0, until - Date.now()) : 0;
	}

	async login(username: string, password: string): Promise<{ ok: boolean; error?: string }> {
		// Nunca logar senha.
		if (!username?.trim() || !password) {
			return { ok: false, error: 'Informe usuário e senha.' };
		}
		if (this.isLockedOut()) {
			return { ok: false, error: `Conta bloqueada temporariamente. Tente novamente em ${Math.ceil(this.remainingLockoutMs() / 1000 / 60)} minuto(s).` };
		}

		let user: AuthUser | null = null;
		let token = '';

		try {
			const response = await firstValueFrom(
				this.http.post<LoginResponse>(`${API_BASE_URL}/auth/login`, {
					username: username.trim(),
					password,
				}),
			);
			user = {
				id: response.user.id,
				name: response.user.name,
				role: (response.user.role as Role),
			};
			token = response.token;
		} catch (error) {
			// Fallback de demonstração quando a API não está disponível.
			// Em produção, remover este bloco e exigir o back-end.
			const matched = DEMO_USERS.find(
				(u) => u.username.toLowerCase() === username.trim().toLowerCase() && u.password === password,
			);
			if (!matched) {
				const attempts = this.incrementAttempts();
				if (attempts >= MAX_ATTEMPTS) {
					this.setLockout();
					return {
						ok: false,
						error: 'Muitas tentativas. Conta bloqueada por 5 minutos.',
					};
				}
				return {
					ok: false,
					error: `Usuário ou senha inválidos. Tentativa ${attempts} de ${MAX_ATTEMPTS}.`,
				};
			}
			user = matched.user;
			token = 'demo-token-' + Date.now();
		}

		this.clearLockout();
		if (!user) {
			return { ok: false, error: 'Falha ao autenticar.' };
		}
		this.writeSession(token, user);
		return { ok: true };
	}

	logout(reason?: string): void {
		this.clearSession();
		if (reason) {
			// Não exibe o motivo em tela de login para não vaziar informações.
		}
	}

	hasToken(): boolean {
		return Boolean(this.token());
	}
}
