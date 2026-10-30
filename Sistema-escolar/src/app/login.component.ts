import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuthService } from './core/auth.service';

@Component({
	selector: 'app-login',
	standalone: true,
	imports: [CommonModule, FormsModule],
	templateUrl: './login.component.html',
	styleUrl: './login.component.css',
})
export class LoginComponent {
	private readonly auth = inject(AuthService);

	username = '';
	password = '';
	loading = false;
	error = '';
	showPassword = false;

	readonly isLockedOut = () => this.auth.isLockedOut();
	readonly remainingLockoutMs = () => this.auth.remainingLockoutMs();

	async onSubmit(event: Event): Promise<void> {
		event.preventDefault();
		this.error = '';
		this.loading = true;
		try {
			const result = await this.auth.login(this.username, this.password);
			if (!result.ok) {
				this.error = result.error ?? 'Falha ao entrar.';
				return;
			}
		} catch {
			this.error = 'Não foi possível conectar ao servidor de autenticação.';
		} finally {
			this.loading = false;
		}
	}

	toggleShowPassword(): void {
		this.showPassword = !this.showPassword;
	}

	get passwordFieldType(): string {
		return this.showPassword ? 'text' : 'password';
	}

	get lockoutMinutes(): number {
		return Math.ceil(this.remainingLockoutMs() / 1000 / 60);
	}
}
