package sshx

import "testing"

func TestBookmarksRoundTrip(t *testing.T) {
	items, err := ParseBookmarks("")
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 0 {
		t.Fatalf("empty file got %d", len(items))
	}
	items, err = AddBookmark(items, "https://example.com/a", "Example")
	if err != nil {
		t.Fatal(err)
	}
	items, err = AddBookmark(items, "https://example.com/a", "Renamed")
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].Title != "Renamed" {
		t.Fatalf("update got %#v", items)
	}
	if _, err := AddBookmark(items, "javascript:alert(1)", "nope"); err == nil {
		t.Fatal("expected reject")
	}
	text, err := MarshalBookmarks(items)
	if err != nil {
		t.Fatal(err)
	}
	back, err := ParseBookmarks(text)
	if err != nil {
		t.Fatal(err)
	}
	if len(back) != 1 || back[0].URL != "https://example.com/a" {
		t.Fatalf("round trip %#v", back)
	}
	back = RemoveBookmark(back, "https://example.com/a")
	if len(back) != 0 {
		t.Fatalf("remove got %#v", back)
	}
}

func TestParseBrowserHistory(t *testing.T) {
	got, err := parseBrowserHistory(`[
	  {"url":"https://example.com","title":"Example","visitedAt":1700000000000},
	  {"url":"chrome://newtab","title":"新标签页","visitedAt":1700000001000},
	  {"url":"https://blank.test","title":"","visitedAt":1}
	]`)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("got %#v", got)
	}
	if got[0].Title != "Example" || got[1].Title != "https://blank.test" {
		t.Fatalf("titles %#v", got)
	}
	empty, err := parseBrowserHistory("  ")
	if err != nil || len(empty) != 0 {
		t.Fatalf("blank %#v %v", empty, err)
	}
	if _, err := parseBrowserHistory("nope"); err == nil {
		t.Fatal("expected bad json")
	}
}
