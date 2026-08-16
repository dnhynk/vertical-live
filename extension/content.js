// content.js (CEO 픽 '명작' + 로그 다이어트 버전)

// 1. 네트워크 인터셉터 주입 (필요시 사용)
const s = document.createElement('script');
s.src = chrome.runtime.getURL('injected.js');
s.onload = function () { this.remove(); };
(document.head || document.documentElement).appendChild(s);

// 2. 좋아요 텍스트 추출 함수
function getLikeCountText() {
    // 유튜브 UI 클래스명은 자주 바뀌므로 여러 후보군을 두는 것이 좋음 (현재는 유지)
    const targets = document.querySelectorAll('.yt-spec-button-shape-next__button-text-content');

    for (let el of targets) {
        const text = el.innerText.trim();
        const cleanText = text.replace(/\n/g, "").trim();

        // 숫자, 좋아요, Like 텍스트 감지
        if (cleanText.length > 0 && (/\d/.test(cleanText) || cleanText === "좋아요" || cleanText.toLowerCase() === "like")) {
            return cleanText;
        }
    }
    return null;
}

// 3. 감시자 실행
function startLikeObserver() {
    let lastLikeCount = "";
    console.log("✅ 좋아요 감시자 가동 (로그 최소화 모드)");

    setInterval(() => {
        const currentCount = getLikeCountText();

        // 값이 존재하고, 이전과 다를 때만 실행
        if (currentCount && currentCount !== lastLikeCount) {
            lastLikeCount = currentCount;

            // 콘솔창 도배 방지: 변화가 있을 때만 로그 출력
            console.log(`👍 [Update] 좋아요 변경: "${currentCount}"`);

            // 백엔드로 전송
            fetch('http://localhost:5002/api/log', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'LIKE', count: currentCount })
            }).catch(() => {
                // 서버가 꺼져있을 때 에러 로그가 너무 많이 뜨지 않게 빈칸 처리
            });
        }
    }, 1000); // 1초 폴링은 최신 CPU에서 부하 0에 수렴함. 유지.
}

// 페이지 로드 대기 후 실행
setTimeout(startLikeObserver, 2000);

// 4. 패킷 릴레이 (슈퍼챗 등 확장성 대비)
window.addEventListener("message", (event) => {
    if (event.source != window || !event.data.type) return;
    if (event.data.type === "PIKACHU_PACKET") {
        fetch('http://localhost:5002/api/log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(event.data.payload)
        }).catch(() => { });
    }
});