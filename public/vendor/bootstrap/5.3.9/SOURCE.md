# Bootstrap 5.3.9 (CSS만 포함)

- 버전: 5.3.9 (2026-11-17 기준 공식 문서의 최신 안정 버전. `docs/6.0`은 `v6.0.0-alpha.1`이라 쓰지 않음)
- 라이선스: MIT (`LICENSE`, Copyright 2011-2026 The Bootstrap Authors)
- 확인한 공식 문서
  - https://getbootstrap.com/docs/5.3/getting-started/introduction/ ("Currently v5.3.9.")
  - https://getbootstrap.com/docs/5.3/getting-started/download/
  - https://getbootstrap.com/docs/versions/
- 내려받은 주소(공식 문서가 안내하는 jsDelivr 배포본)
  - https://cdn.jsdelivr.net/npm/bootstrap@5.3.9/dist/css/bootstrap.min.css
  - https://cdn.jsdelivr.net/npm/bootstrap@5.3.9/dist/css/bootstrap.min.css.map
  - https://cdn.jsdelivr.net/npm/bootstrap@5.3.9/LICENSE
- 무결성
  - `bootstrap.min.css` SRI: `sha384-yEPZ7jP9S0QKiUQ0m3jjsO4ProIW7wvR9gXkI7JOGa2XVsw53Yke2bsdkBbjmmiX` (공식 문서 값과 내려받은 파일의 계산값이 같음)
  - `bootstrap.min.css` SHA-256: `9caac977a0af0c2229abd397eee3345899c4020da2a1a0b711c1cc543fe3719d`
  - `bootstrap.min.css.map` SHA-256: `18f584922933e424f32ec9484c9b4acdfda2706d303c6ed1bdf2db1bf0ab7ad3`
  - `LICENSE` SHA-256: `bc0cd18d94c028f1c0b62ec9fdaddcb9921c1e07c29cf52dc7df8cca9daf2488`

빌드 단계 없이 `index.html`이 이 파일을 로컬 `<link>`로 읽고, 그 뒤에 `style.css`가 색상 토큰과 구성 요소를 덮어씁니다. Bootstrap JavaScript는 포함하지 않습니다(탭은 `public/lib/tab-navigation.mjs`가 처리). 파일을 바꾸지 말고, 버전을 올릴 때는 새 디렉터리를 만들고 해시를 다시 기록합니다.
