import { TestBed } from '@angular/core/testing';
import { AppComponent } from './app.component';
import { commonTestProviders } from '../test/test-providers';

describe('AppComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [...commonTestProviders]
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  // Removed legacy title tests (template no longer renders a static h1)
});
