-- Coreview Attendance - initial schema (MySQL 8.0.16+ recommended)
-- All timestamps are stored in UTC as DATETIME(3). Work dates are DATE values
-- calculated in the company timezone (default Africa/Lagos) by the application.
SET time_zone = '+00:00';

CREATE TABLE users (
  id                   INT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id          VARCHAR(32)  NOT NULL,
  full_name            VARCHAR(120) NOT NULL,
  email                VARCHAR(190) NULL,
  phone                VARCHAR(32)  NULL,
  department           VARCHAR(100) NULL,
  job_title            VARCHAR(100) NULL,
  role                 ENUM('hr','employee') NOT NULL DEFAULT 'employee',
  password_hash        VARCHAR(255) NOT NULL,
  must_change_password TINYINT(1)   NOT NULL DEFAULT 1,
  is_active            TINYINT(1)   NOT NULL DEFAULT 1,
  start_date           DATE         NOT NULL,
  end_date             DATE         NULL COMMENT 'Set when deactivated; later days are not counted as absences',
  failed_login_count   SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  locked_until         DATETIME(3)  NULL,
  last_login_at        DATETIME(3)  NULL,
  password_changed_at  DATETIME(3)  NULL,
  created_at           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_employee_id (employee_id),
  UNIQUE KEY uq_users_email (email),
  KEY idx_users_role_active (role, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE sessions (
  id                  INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id             INT UNSIGNED NOT NULL,
  token_hash          CHAR(64)     NOT NULL COMMENT 'SHA-256 of the cookie token; the raw token is never stored',
  created_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at          DATETIME(3)  NOT NULL COMMENT 'Sliding idle expiry',
  absolute_expires_at DATETIME(3)  NOT NULL COMMENT 'Hard limit regardless of activity',
  ip                  VARCHAR(45)  NULL,
  user_agent          VARCHAR(255) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sessions_token (token_hash),
  KEY idx_sessions_user (user_id),
  KEY idx_sessions_expires (expires_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE settings (
  id                TINYINT UNSIGNED NOT NULL,
  company_name      VARCHAR(120)  NOT NULL DEFAULT 'Coreview',
  office_latitude   DECIMAL(10,7) NULL,
  office_longitude  DECIMAL(10,7) NULL,
  geofence_radius_m INT UNSIGNED  NOT NULL DEFAULT 50,
  max_accuracy_m    INT UNSIGNED  NOT NULL DEFAULT 50 COMMENT 'Reject GPS readings less accurate than this',
  resume_time       TIME          NOT NULL DEFAULT '08:00:00',
  close_time        TIME          NOT NULL DEFAULT '17:00:00',
  grace_minutes     SMALLINT UNSIGNED NOT NULL DEFAULT 10,
  working_days      VARCHAR(20)   NOT NULL DEFAULT '1,2,3,4,5' COMMENT '0=Sunday ... 6=Saturday',
  timezone          VARCHAR(64)   NOT NULL DEFAULT 'Africa/Lagos',
  updated_by        INT UNSIGNED  NULL,
  updated_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT chk_settings_singleton CHECK (id = 1),
  CONSTRAINT chk_settings_hours CHECK (close_time > resume_time),
  CONSTRAINT fk_settings_user FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO settings (id) VALUES (1);

CREATE TABLE holidays (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  holiday_date DATE         NOT NULL,
  description  VARCHAR(160) NOT NULL,
  created_by   INT UNSIGNED NULL,
  created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_holidays_date (holiday_date),
  CONSTRAINT fk_holidays_user FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per employee per work date. Only RECORDED events live here.
-- Absence and missing-sign-out are CALCULATED from this table, never stored.
CREATE TABLE attendance (
  id                  INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id             INT UNSIGNED NOT NULL,
  work_date           DATE         NOT NULL,
  sign_in_at          DATETIME(3)  NOT NULL,
  sign_out_at         DATETIME(3)  NULL,
  punctuality         ENUM('on_time','late') NOT NULL COMMENT 'Snapshot of the policy at sign-in time',
  late_minutes        INT UNSIGNED NOT NULL DEFAULT 0,
  sign_in_lat         DECIMAL(10,7) NULL,
  sign_in_lng         DECIMAL(10,7) NULL,
  sign_in_distance_m  DECIMAL(8,2)  NULL,
  sign_in_accuracy_m  DECIMAL(8,2)  NULL,
  sign_out_lat        DECIMAL(10,7) NULL,
  sign_out_lng        DECIMAL(10,7) NULL,
  sign_out_distance_m DECIMAL(8,2)  NULL,
  sign_out_accuracy_m DECIMAL(8,2)  NULL,
  sign_in_request_id  VARCHAR(64)  NULL COMMENT 'Client idempotency key so retries are safe',
  sign_out_request_id VARCHAR(64)  NULL,
  source              ENUM('self','correction') NOT NULL DEFAULT 'self',
  is_stale            TINYINT(1)   NOT NULL DEFAULT 0 COMMENT 'Open session from a past day (missing sign-out); no longer blocks new sign-ins',
  open_guard          INT UNSIGNED GENERATED ALWAYS AS (IF(sign_out_at IS NULL AND is_stale = 0, user_id, NULL)) STORED,
  created_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_attendance_user_date (user_id, work_date),
  UNIQUE KEY uq_attendance_open_guard (open_guard),
  KEY idx_attendance_date (work_date),
  CONSTRAINT chk_attendance_order CHECK (sign_out_at IS NULL OR sign_out_at > sign_in_at),
  CONSTRAINT fk_attendance_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE audit_logs (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  actor_id       INT UNSIGNED NOT NULL,
  action         VARCHAR(60)  NOT NULL,
  entity_type    VARCHAR(40)  NOT NULL,
  entity_id      INT UNSIGNED NULL,
  target_user_id INT UNSIGNED NULL,
  reason         VARCHAR(500) NULL,
  old_values     JSON         NULL,
  new_values     JSON         NULL,
  ip             VARCHAR(45)  NULL,
  created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_audit_entity (entity_type, entity_id),
  KEY idx_audit_target (target_user_id),
  KEY idx_audit_actor (actor_id),
  KEY idx_audit_created (created_at),
  CONSTRAINT fk_audit_actor FOREIGN KEY (actor_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_audit_target FOREIGN KEY (target_user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
