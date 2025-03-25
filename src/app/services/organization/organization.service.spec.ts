import { TestBed } from '@angular/core/testing';

import { OrganizationService } from './organization.service';
import { CommonModule } from '@angular/common';
import { Component, inject } from '@angular/core';
import { Auth } from '@angular/fire/auth';
import { Firestore } from '@angular/fire/firestore';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { addDoc, collection } from 'firebase/firestore';
import { Organization } from '../../models/organization.model';

describe('OrganizationService', () => {
  let service: OrganizationService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(OrganizationService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});